"""Claude Agent SDK adapter for AG-UI protocol."""

import asyncio
import os
import logging
import json
import uuid
from typing import AsyncIterator, Optional, List, Dict, Any, Union, TYPE_CHECKING

from ag_ui.core import (
    EventType,
    RunAgentInput,
    BaseEvent,
    AssistantMessage as AguiAssistantMessage,
    ToolCall as AguiToolCall,
    FunctionCall as AguiFunctionCall,
    RunStartedEvent,
    RunFinishedEvent,
    RunErrorEvent,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    StateSnapshotEvent,
    MessagesSnapshotEvent,
    ThinkingTextMessageStartEvent,
    ThinkingTextMessageContentEvent,
    ThinkingTextMessageEndEvent,
    ThinkingStartEvent,
    ThinkingEndEvent,
)

if TYPE_CHECKING:
    from claude_agent_sdk import ClaudeAgentOptions

from .utils import (
    build_state_context_addendum,
    convert_agui_tool_to_claude_sdk,
    create_state_management_tool,
    apply_forwarded_props,
    extract_tool_names,
    strip_mcp_prefix,
    build_agui_assistant_message,
    build_agui_tool_message,
)
from .config import (
    ALLOWED_FORWARDED_PROPS,
    STATE_MANAGEMENT_TOOL_NAME,
    STATE_MANAGEMENT_TOOL_FULL_NAME,
    AG_UI_MCP_SERVER_NAME,
)
from .handlers import (
    handle_tool_use_block,
    handle_tool_result_block,
    emit_system_message_events,
)
from .session import SessionWorker

logger = logging.getLogger(__name__)

if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
    logger.addHandler(handler)
    logger.setLevel(getattr(logging, os.getenv("LOGLEVEL", "INFO").upper(), logging.INFO))


class ClaudeAgentAdapter:
    """
    AG-UI adapter for the Anthropic Claude Agent SDK.
    
    Manages the SDK client lifecycle internally via per-thread session workers.
    Call ``run(input_data)`` to get an async iterator of AG-UI events.
    """

    def __init__(
        self,
        name: str,
        options: Union["ClaudeAgentOptions", dict, None] = None,
        description: str = "",
    ):
        self.name = name
        self.description = description
        self._options = options
        self._last_result_data: Optional[Dict[str, Any]] = None
        self._current_state: Optional[Any] = None
        self._workers: Dict[str, SessionWorker] = {}

    async def interrupt(self, thread_id: Optional[str] = None) -> None:
        """Interrupt the active query for a thread, or all workers if no thread specified."""
        if thread_id and thread_id in self._workers:
            await self._workers[thread_id].interrupt()
        else:
            for worker in self._workers.values():
                await worker.interrupt()
                break

    async def shutdown(self) -> None:
        """Gracefully stop all session workers. Call on server shutdown."""
        for worker in list(self._workers.values()):
            await worker.stop()
        self._workers.clear()

    async def run(self, input_data: RunAgentInput) -> AsyncIterator[BaseEvent]:
        """Run the agent and yield AG-UI events."""
        from .utils import process_messages

        thread_id = input_data.thread_id or str(uuid.uuid4())
        run_id = input_data.run_id or str(uuid.uuid4())
        
        self._last_result_data = None
        self._current_state = input_data.state
        
        try:
            # Get or create worker for this thread
            worker = self._workers.get(thread_id)
            if worker is None:
                options = self.build_options(input_data, thread_id=thread_id)
                worker = SessionWorker(thread_id, options)
                await worker.start()
                self._workers[thread_id] = worker
                logger.debug(f"Created worker for thread={thread_id}")
            else:
                logger.debug(f"Reusing worker for thread={thread_id}")

            prompt, _ = process_messages(input_data)
            message_stream = worker.query(prompt, session_id=thread_id)

            # Log parent_run_id if provided (for branching/time travel tracking)
            if input_data.parent_run_id:
                logger.debug(
                    f"Run {run_id[:8]}... is branched from parent run {input_data.parent_run_id[:8]}..."
                )
            
            # Emit RUN_STARTED
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=thread_id,
                run_id=run_id,
                parent_run_id=input_data.parent_run_id,
                input={
                    "thread_id": thread_id,
                    "run_id": run_id,
                    "parent_run_id": input_data.parent_run_id,
                    "messages": input_data.messages,
                    "tools": input_data.tools,
                    "state": input_data.state,
                    "context": input_data.context,
                    "forwarded_props": input_data.forwarded_props,
                }
            )
            
            # Extract frontend tool names for halt detection
            frontend_tool_names = set(extract_tool_names(input_data.tools)) if input_data.tools else set()
            if frontend_tool_names:
                logger.debug(f"Frontend tools detected: {frontend_tool_names}")
            
            # Emit initial state snapshot if provided
            if input_data.state:
                yield StateSnapshotEvent(
                    type=EventType.STATE_SNAPSHOT,
                    snapshot=input_data.state
                )
            
            # Translate Claude SDK messages into AG-UI events
            async for event in self._stream_claude_sdk(
                message_stream, thread_id, run_id, input_data, frontend_tool_names
            ):
                yield event
            
            # Emit RUN_FINISHED
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=thread_id,
                run_id=run_id,
                result=self._last_result_data,
            )
            
        except Exception as e:
            logger.error(f"Error in run: {e}")
            # Evict broken worker
            broken = self._workers.pop(thread_id, None)
            if broken:
                await broken.stop()
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                thread_id=thread_id,
                run_id=run_id,
                message=str(e),
            )

    def build_options(self, input_data: Optional[RunAgentInput] = None, thread_id: Optional[str] = None) -> "ClaudeAgentOptions":
        """Build ClaudeAgentOptions from base config + RunAgentInput."""
        from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server
        
        # Start with sensible defaults
        merged_kwargs: Dict[str, Any] = {
            "include_partial_messages": True,
            "stderr": lambda data: logger.debug(f"[Claude CLI stderr] {data.rstrip()}"),
        }
        
        # Merge in provided options
        if self._options is not None:
            if isinstance(self._options, dict):
                # Dict format - merge directly
                for key, value in self._options.items():
                    if value is not None:
                        merged_kwargs[key] = value
                           
            else:
                # ClaudeAgentOptions object - extract attributes
                # Try Pydantic v2 style first
                if hasattr(self._options, "model_dump"):
                    base_dict = self._options.model_dump(exclude_none=True)
                    merged_kwargs.update(base_dict)
                # Fall back to Pydantic v1 style
                elif hasattr(self._options, "dict"):
                    base_dict = self._options.dict(exclude_none=True)
                    merged_kwargs.update(base_dict)
                # Fall back to __dict__ for plain dataclasses/objects
                elif hasattr(self._options, "__dict__"):
                    for key, value in self._options.__dict__.items():
                        if not key.startswith("_") and value is not None:
                            merged_kwargs[key] = value
        logger.debug(f"Merged kwargs: {merged_kwargs}")
        
        # Append state and context to the system prompt (not the user message).
        if input_data:
            addendum = build_state_context_addendum(input_data)
            if addendum:
                base = merged_kwargs.get("system_prompt", "") or ""
                merged_kwargs["system_prompt"] = f"{base}\n\n{addendum}" if base else addendum
                logger.debug(f"Appended state/context ({len(addendum)} chars) to system_prompt")
        
        # Ensure ag_ui tools are always allowed (frontend tools + state management)
        if input_data and (input_data.state or input_data.tools):
            allowed_tools = merged_kwargs.get("allowed_tools", [])
            tools_to_add = []
            
            # Add state management tool if state is provided
            if input_data.state and STATE_MANAGEMENT_TOOL_FULL_NAME not in allowed_tools:
                tools_to_add.append(STATE_MANAGEMENT_TOOL_FULL_NAME)
            
            # Add frontend tools (prefixed with mcp__ag_ui__)
            if input_data.tools:
                for tool_name in extract_tool_names(input_data.tools):
                    prefixed_name = f"mcp__ag_ui__{tool_name}"
                    if prefixed_name not in allowed_tools:
                        tools_to_add.append(prefixed_name)
            
            if tools_to_add:
                merged_kwargs["allowed_tools"] = [*allowed_tools, *tools_to_add]
                logger.debug(f"Auto-granted permission to ag_ui tools: {tools_to_add}")
        
        # Remove api_key from options kwargs (handled via environment variable)
        merged_kwargs.pop("api_key", None)
        logger.debug(f"Merged kwargs after pop: {merged_kwargs}")
        
        # Apply forwarded_props as per-run overrides (before adding dynamic tools)
        if input_data and input_data.forwarded_props:
            merged_kwargs = apply_forwarded_props(
                input_data.forwarded_props, 
                merged_kwargs, 
                ALLOWED_FORWARDED_PROPS
            )
        
        # Add dynamic tools from input.tools and state management
        if input_data:
            # Get existing MCP servers
            existing_servers = merged_kwargs.get("mcp_servers", {})
            ag_ui_tools = []
            
            # Add frontend tools from input.tools
            if input_data.tools:
                logger.debug(f"Building dynamic MCP server with {len(input_data.tools)} frontend tools")
                
                for tool_def in input_data.tools:
                    try:
                        claude_tool = convert_agui_tool_to_claude_sdk(tool_def)
                        ag_ui_tools.append(claude_tool)
                    except Exception as e:
                        logger.warning(f"Failed to convert tool: {e}")
            
            # Add state management tool if state is provided
            if input_data.state:
                logger.debug("Adding ag_ui_update_state tool for state management")
                state_tool = create_state_management_tool()
                ag_ui_tools.append(state_tool)
            
            # Create ag_ui MCP server if we have any tools
            if ag_ui_tools:
                ag_ui_server = create_sdk_mcp_server(
                    AG_UI_MCP_SERVER_NAME,
                    "1.0.0",
                    tools=ag_ui_tools
                )
                
                # Merge with existing servers
                merged_kwargs["mcp_servers"] = {
                    **existing_servers,
                    AG_UI_MCP_SERVER_NAME: ag_ui_server
                }
                
                # Get tool names safely (SdkMcpTool objects don't have __name__)
                tool_names = []
                for t in ag_ui_tools:
                    if hasattr(t, '__name__'):
                        tool_names.append(t.__name__)
                    elif hasattr(t, 'name'):
                        tool_names.append(t.name)
                    else:
                        tool_names.append(str(type(t).__name__))
                
                logger.debug(
                    f"Created ag_ui MCP server with {len(ag_ui_tools)} tools: {tool_names}"
                )
        
        
        logger.debug(f"Creating ClaudeAgentOptions with merged kwargs: {merged_kwargs}")
        return ClaudeAgentOptions(**merged_kwargs)

    async def _stream_claude_sdk(
        self,
        message_stream: Any,
        thread_id: str,
        run_id: str,
        input_data: RunAgentInput,
        frontend_tool_names: set[str],
    ) -> AsyncIterator[BaseEvent]:
        """Translate a Claude SDK message stream into AG-UI events."""
        # Per-run state (local to this invocation)
        current_message_id: Optional[str] = None
        in_thinking_block: bool = False
        has_streamed_text: bool = False
        
        # Tool call streaming state
        current_tool_call_id: Optional[str] = None
        current_tool_call_name: Optional[str] = None
        current_tool_display_name: Optional[str] = None
        accumulated_tool_json: str = ""
        
        # Track which tools we've already emitted START for (to avoid duplicates)
        processed_tool_ids: set = set()
        
        # Frontend tool halt flag
        halt_event_stream: bool = False
        
        # ── MESSAGES_SNAPSHOT accumulation ──
        run_messages: List[Any] = []
        pending_msg: Optional[Dict[str, Any]] = None
        accumulated_thinking_text = ""

        def _get_msg_id(msg):
            """Extract message ID from either a dict or an object."""
            if isinstance(msg, dict):
                return msg.get("id")
            return getattr(msg, "id", None)

        def upsert_message(msg):
            """Upsert a message: replace if same ID exists, otherwise append."""
            msg_id = _get_msg_id(msg)
            if msg_id is not None:
                for i, m in enumerate(run_messages):
                    if _get_msg_id(m) == msg_id:
                        run_messages[i] = msg
                        return
            run_messages.append(msg)

        def flush_pending_msg():
            """Flush pendingMsg -> run_messages."""
            nonlocal pending_msg
            if pending_msg is None:
                return
            # Use explicit `is not None` checks — empty string "" is falsy but
            # a message with empty content and non-empty tool_calls is valid.
            has_content = pending_msg.get("content") is not None and pending_msg["content"] != ""
            has_tools = bool(pending_msg.get("tool_calls"))
            if has_content or has_tools:
                upsert_message(
                    AguiAssistantMessage(
                        id=pending_msg["id"],
                        role="assistant",
                        content=pending_msg["content"] if has_content else None,
                        tool_calls=pending_msg["tool_calls"] if has_tools else None,
                    )
                )
            pending_msg = None
        
        
        from claude_agent_sdk import (
            AssistantMessage,
            UserMessage,
            SystemMessage,
            ResultMessage,
            ToolUseBlock,
            ToolResultBlock,
        )
        from claude_agent_sdk.types import StreamEvent
        
        
        message_count = 0
        
        async for message in message_stream:
            message_count += 1
            
            # If we've halted due to frontend tool, break out of loop
            if halt_event_stream:
                logger.debug(f"[Message #{message_count}]: Halted - breaking stream loop")
                break
            
            logger.debug(f"[Message #{message_count}]: {type(message).__name__}")
            
            # Handle StreamEvent for real-time streaming chunks
            if isinstance(message, StreamEvent):
                event_data = message.event
                event_type = event_data.get('type')
                
                if event_type == 'message_start':
                    current_message_id = str(uuid.uuid4())
                    has_streamed_text = False
                    pending_msg = {"id": current_message_id, "content": "", "tool_calls": []}
                
                elif event_type == 'content_block_delta':
                    delta_data = event_data.get('delta', {})
                    delta_type = delta_data.get('type', '')
                    
                    if delta_type == 'text_delta':
                        text_chunk = delta_data.get('text', '')
                        if text_chunk and current_message_id:
                            if not has_streamed_text:
                                yield TextMessageStartEvent(
                                    type=EventType.TEXT_MESSAGE_START,
                                    thread_id=thread_id,
                                    run_id=run_id,
                                    message_id=current_message_id,
                                    role="assistant",
                                )
                            has_streamed_text = True
                            if pending_msg is not None:
                                pending_msg["content"] += text_chunk
                            
                            yield TextMessageContentEvent(
                                type=EventType.TEXT_MESSAGE_CONTENT,
                                thread_id=thread_id,
                                run_id=run_id,
                                message_id=current_message_id,
                                delta=text_chunk,
                            )
                    elif delta_type == 'thinking_delta':
                        thinking_chunk = delta_data.get('thinking', '')
                        if thinking_chunk:
                            accumulated_thinking_text += thinking_chunk
                            yield ThinkingTextMessageContentEvent(
                                type=EventType.THINKING_TEXT_MESSAGE_CONTENT,
                                delta=thinking_chunk,
                            )
                    elif delta_type == 'input_json_delta':
                        partial_json = delta_data.get('partial_json', '')
                        if partial_json and current_tool_call_id:
                            accumulated_tool_json += partial_json
                            yield ToolCallArgsEvent(
                                type=EventType.TOOL_CALL_ARGS,
                                thread_id=thread_id,
                                run_id=run_id,
                                tool_call_id=current_tool_call_id,
                                delta=partial_json,
                            )
                
                elif event_type == 'content_block_start':
                    block_data = event_data.get('content_block', {})
                    block_type = block_data.get('type', '')
                    
                    if block_type == 'thinking':
                        in_thinking_block = True
                        yield ThinkingStartEvent(type=EventType.THINKING_START)
                        yield ThinkingTextMessageStartEvent(type=EventType.THINKING_TEXT_MESSAGE_START)
                    elif block_type == 'tool_use':
                        current_tool_call_id = block_data.get('id')
                        current_tool_call_name = block_data.get('name', 'unknown')
                        accumulated_tool_json = ""
                        
                        if current_tool_call_id:
                            current_tool_display_name = strip_mcp_prefix(current_tool_call_name)
                            processed_tool_ids.add(current_tool_call_id)
                            
                            yield ToolCallStartEvent(
                                type=EventType.TOOL_CALL_START,
                                thread_id=thread_id,
                                run_id=run_id,
                                tool_call_id=current_tool_call_id,
                                tool_call_name=current_tool_display_name,
                                parent_message_id=current_message_id,
                            )
                
                elif event_type == 'content_block_stop':
                    if in_thinking_block:
                        in_thinking_block = False
                        yield ThinkingTextMessageEndEvent(type=EventType.THINKING_TEXT_MESSAGE_END)
                        yield ThinkingEndEvent(type=EventType.THINKING_END)

                        if accumulated_thinking_text:
                            from ag_ui.core import DeveloperMessage
                            upsert_message(DeveloperMessage(
                                id=str(uuid.uuid4()),
                                role="developer",
                                content=accumulated_thinking_text,
                            ))
                            accumulated_thinking_text = ""
                    
                    # Close tool call if we were streaming one
                    if current_tool_call_id:
                        # Check if this is the state management tool
                        if current_tool_call_name in (STATE_MANAGEMENT_TOOL_NAME, STATE_MANAGEMENT_TOOL_FULL_NAME):
                            try:
                                state_updates = json.loads(accumulated_tool_json)
                                if isinstance(state_updates, dict):
                                    updates = state_updates.get("state_updates", state_updates)
                                    if isinstance(updates, str):
                                        updates = json.loads(updates)
                                    if isinstance(self._current_state, dict) and isinstance(updates, dict):
                                        self._current_state = {**self._current_state, **updates}
                                    else:
                                        self._current_state = updates
                                    yield StateSnapshotEvent(
                                        type=EventType.STATE_SNAPSHOT,
                                        snapshot=self._current_state
                                    )
                            except (json.JSONDecodeError, ValueError) as e:
                                logger.warning(f"Failed to parse tool JSON for state update: {e}")
                        
                        # Push tool call onto in-flight message (skip state management)
                        if (
                            pending_msg is not None
                            and current_tool_call_id
                            and current_tool_display_name
                            and current_tool_call_name not in (STATE_MANAGEMENT_TOOL_NAME, STATE_MANAGEMENT_TOOL_FULL_NAME)
                        ):
                            pending_msg["tool_calls"].append(
                                AguiToolCall(
                                    id=current_tool_call_id,
                                    type="function",
                                    function=AguiFunctionCall(
                                        name=current_tool_display_name,
                                        arguments=accumulated_tool_json,
                                    ),
                                )
                            )

                        # Check if this is a frontend tool -- halt stream
                        is_frontend_tool = current_tool_display_name in frontend_tool_names
                        
                        if is_frontend_tool:
                            flush_pending_msg()

                            yield ToolCallEndEvent(
                                type=EventType.TOOL_CALL_END,
                                thread_id=thread_id,
                                run_id=run_id,
                                tool_call_id=current_tool_call_id,
                            )
                            
                            if current_message_id and has_streamed_text:
                                yield TextMessageEndEvent(
                                    type=EventType.TEXT_MESSAGE_END,
                                    thread_id=thread_id,
                                    run_id=run_id,
                                    message_id=current_message_id,
                                )
                                current_message_id = None

                            logger.debug(f"Frontend tool halt: {current_tool_display_name}")
                            current_tool_call_id = None
                            current_tool_call_name = None
                            current_tool_display_name = None
                            accumulated_tool_json = ""
                            halt_event_stream = True
                            continue
                        
                        # Reset tool streaming state
                        current_tool_call_id = None
                        current_tool_call_name = None
                        current_tool_display_name = None
                        accumulated_tool_json = ""
                
                elif event_type == 'message_stop':
                    flush_pending_msg()

                    if current_message_id and has_streamed_text:
                        yield TextMessageEndEvent(
                            type=EventType.TEXT_MESSAGE_END,
                            thread_id=thread_id,
                            run_id=run_id,
                            message_id=current_message_id,
                        )
                    current_message_id = None
                
                elif event_type == 'message_delta':
                    delta_data = event_data.get('delta', {})
                    stop_reason = delta_data.get('stop_reason')
                    if stop_reason:
                        logger.debug(f"Message stop_reason: {stop_reason}")
                
                continue
            
            # Handle complete messages
            if isinstance(message, (AssistantMessage, UserMessage)):
                if isinstance(message, AssistantMessage):
                    msg_id = current_message_id or str(uuid.uuid4())
                    agui_msg = build_agui_assistant_message(message, msg_id)
                    if agui_msg:
                        upsert_message(agui_msg)

                # Process non-streamed blocks (fallback for tools not seen via stream events)
                for block in getattr(message, 'content', []) or []:
                    if isinstance(block, ToolUseBlock):
                        tool_id = getattr(block, 'id', None)
                        if tool_id and tool_id in processed_tool_ids:
                            continue
                        updated_state, tool_events = await handle_tool_use_block(
                            block, message, thread_id, run_id, self._current_state
                        )
                        if tool_id:
                            processed_tool_ids.add(tool_id)
                        if updated_state is not None:
                            self._current_state = updated_state
                        async for event in tool_events:
                            yield event
                    
                    elif isinstance(block, ToolResultBlock):
                        tool_use_id = getattr(block, 'tool_use_id', None)
                        block_content = getattr(block, 'content', None)
                        if tool_use_id:
                            upsert_message(build_agui_tool_message(tool_use_id, block_content))
                        parent_id = getattr(message, 'parent_tool_use_id', None)
                        async for event in handle_tool_result_block(block, thread_id, run_id, parent_id):
                            yield event
            
            elif isinstance(message, SystemMessage):
                subtype = getattr(message, 'subtype', '')
                data = getattr(message, 'data', {}) or {}
                
                msg_text = (data.get('message') or data.get('text') or '') if data else ''
                
                if msg_text:
                    sys_msg_id = str(uuid.uuid4())
                    for evt in emit_system_message_events(thread_id, run_id, msg_text):
                        yield evt
                    
                    from ag_ui.core import SystemMessage as AguiSystemMessage
                    upsert_message(AguiSystemMessage(
                        id=sys_msg_id,
                        role="system",
                        content=msg_text,
                    ))
            
            elif isinstance(message, ResultMessage):
                is_error = getattr(message, 'is_error', None)
                result_text = getattr(message, 'result', None)
                
                # Capture metadata for RunFinished event
                self._last_result_data = {
                    "is_error": is_error,
                    "duration_ms": getattr(message, 'duration_ms', None),
                    "duration_api_ms": getattr(message, 'duration_api_ms', None),
                    "num_turns": getattr(message, 'num_turns', None),
                    "total_cost_usd": getattr(message, 'total_cost_usd', None),
                    "usage": getattr(message, 'usage', None),
                    "structured_output": getattr(message, 'structured_output', None),
                }
                
                if not has_streamed_text and result_text:
                    result_msg_id = str(uuid.uuid4())
                    yield TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, thread_id=thread_id, run_id=run_id, message_id=result_msg_id, role="assistant")
                    yield TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, thread_id=thread_id, run_id=run_id, message_id=result_msg_id, delta=result_text)
                    yield TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, thread_id=thread_id, run_id=run_id, message_id=result_msg_id)

                    upsert_message(AguiAssistantMessage(
                        id=result_msg_id,
                        role="assistant",
                        content=result_text,
                    ))
        
        # ── Event cleanup ──
        # Close any hanging events so the frontend doesn't get stuck
        # waiting for END events that will never arrive.
        # Handles: normal stream completion and halt/break cases.
        if current_tool_call_id:
            logger.debug(f"Cleanup: closing hanging TOOL_CALL_START for {current_tool_call_id}")
            yield ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                thread_id=thread_id,
                run_id=run_id,
                tool_call_id=current_tool_call_id,
            )
            current_tool_call_id = None

        if in_thinking_block:
            logger.debug("Cleanup: closing hanging thinking block")
            yield ThinkingTextMessageEndEvent(type=EventType.THINKING_TEXT_MESSAGE_END)
            yield ThinkingEndEvent(type=EventType.THINKING_END)
            in_thinking_block = False

        if has_streamed_text and current_message_id:
            logger.debug(f"Cleanup: closing hanging TEXT_MESSAGE_START for {current_message_id}")
            yield TextMessageEndEvent(
                type=EventType.TEXT_MESSAGE_END,
                thread_id=thread_id,
                run_id=run_id,
                message_id=current_message_id,
            )

        flush_pending_msg()

        # Emit MESSAGES_SNAPSHOT with input messages + new messages from this run
        if run_messages:
            all_messages = list(input_data.messages or []) + run_messages
            logger.debug(
                f"MESSAGES_SNAPSHOT: {len(all_messages)} msgs ({message_count} SDK messages processed)"
            )
            yield MessagesSnapshotEvent(
                type=EventType.MESSAGES_SNAPSHOT,
                messages=all_messages,
            )

