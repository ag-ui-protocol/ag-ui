"""
Claude Agent SDK adapter for AG-UI protocol.

This adapter wraps the Claude Agent SDK and produces AG-UI protocol events,
enabling Claude-powered agents to work with any AG-UI compatible frontend.
"""

import os
import logging
import json
import uuid
from typing import AsyncIterator, Optional, List, Dict, Any, TYPE_CHECKING
from datetime import datetime, timezone

# AG-UI Protocol Events
from ag_ui.core import (
    EventType,
    RunAgentInput,
    BaseEvent,
    RunStartedEvent,
    RunFinishedEvent,
    RunErrorEvent,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    CustomEvent,
    # Thinking events for extended thinking support
    ThinkingTextMessageStartEvent,
    ThinkingTextMessageContentEvent,
    ThinkingTextMessageEndEvent,
)

# Type checking imports for Claude SDK types
if TYPE_CHECKING:
    from claude_agent_sdk import ClaudeAgentOptions

logger = logging.getLogger(__name__)

# Configure logger if not already configured
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
    logger.addHandler(handler)
    # Respect LOGLEVEL environment variable (defaults to INFO)
    log_level = os.getenv("LOGLEVEL", "INFO").upper()
    logger.setLevel(getattr(logging, log_level, logging.INFO))


class ClaudeAgentAdapter:
    """
    Adapter that wraps the Claude Agent SDK for AG-UI servers.
    
    Produces AG-UI protocol events via async generator from Claude SDK responses.
    
    This adapter dynamically supports all ClaudeAgentOptions from the Claude Agent SDK.
    You can either:
    1. Pass a pre-configured ClaudeAgentOptions instance via the `options` parameter
    2. Pass individual kwargs that will be forwarded to ClaudeAgentOptions
    3. Use a combination of both (kwargs override options)
    
    Example:
        # Using kwargs (recommended for simple cases)
        adapter = ClaudeAgentAdapter(
            cwd="/my/project",
            permission_mode="acceptEdits",
            allowed_tools=["Read", "Write", "Bash"],
        )
        
        # Using pre-configured options
        from claude_agent_sdk import ClaudeAgentOptions
        options = ClaudeAgentOptions(
            cwd="/my/project",
            permission_mode="acceptEdits",
            sandbox={"enabled": True},
        )
        adapter = ClaudeAgentAdapter(options=options)
        
        # Using both (kwargs override options)
        adapter = ClaudeAgentAdapter(
            options=options,
            model="claude-sonnet-4-20250514",  # overrides any model in options
        )
    """

    def __init__(
        self,
        options: Optional["ClaudeAgentOptions"] = None,
        **kwargs: Any,
    ):
        """
        Initialize the Claude Agent adapter.
        
        Args:
            options: Optional pre-configured ClaudeAgentOptions instance.
                    All ClaudeAgentOptions fields are supported.
            **kwargs: Any ClaudeAgentOptions parameters to pass through.
                     These will override values in the options parameter.
                     
                     Common options include:
                     - api_key: Anthropic API key (defaults to ANTHROPIC_API_KEY env var)
                     - model: Claude model to use (e.g., "claude-sonnet-4-20250514")
                     - cwd: Working directory for Claude SDK
                     - max_tokens: Maximum tokens for responses
                     - temperature: Temperature for sampling
                     - system_prompt: Custom system prompt (str or dict)
                     - mcp_servers: Dict of MCP servers
                     - allowed_tools: List of allowed tool names
                     - permission_mode: Permission mode ("default", "acceptEdits", etc.)
                     - include_partial_messages: Whether to include partial messages
                     - sandbox: SandboxSettings configuration
                     - can_use_tool: Async callback for tool permission checks
                     
                     See Claude Agent SDK docs for full list of options:
                     https://platform.claude.com/docs/en/agent-sdk/python
        """
        # Store the base options object if provided
        self._base_options = options
        
        # Store kwargs for later merging with options
        self._options_kwargs = kwargs
        
        # Extract api_key for environment setup (special case)
        self.api_key = kwargs.get("api_key") or os.getenv("ANTHROPIC_API_KEY", "")
        
        # Get cwd for working directory (used for logging/debugging)
        self.cwd = kwargs.get("cwd") or os.getcwd()
        
        # Active client reference (for interrupt support)
        self._active_client: Optional[Any] = None
        
        # Result data from last run (for RunFinished event)
        self._last_result_data: Optional[Dict[str, Any]] = None

    def _timestamp(self) -> str:
        """Return current UTC timestamp in ISO format."""
        return datetime.now(timezone.utc).isoformat()

    def _extract_user_message(self, input_data: RunAgentInput) -> str:
        """Extract user message text from RunAgentInput."""
        messages = input_data.messages or []
        
        # Find the last user message
        for msg in reversed(messages):
            if hasattr(msg, 'role') and msg.role == 'user':
                content = getattr(msg, 'content', '')
                if isinstance(content, str):
                    return content
                elif isinstance(content, list):
                    # Content blocks format
                    for block in content:
                        if hasattr(block, 'text'):
                            return block.text
                        elif isinstance(block, dict) and 'text' in block:
                            return block['text']
            elif isinstance(msg, dict):
                if msg.get('role') == 'user':
                    content = msg.get('content', '')
                    if isinstance(content, str):
                        return content
        
        return ""

    def _emit_system_message(
        self, thread_id: str, run_id: str, message: str
    ) -> List[BaseEvent]:
        """
        Emit a system message as AG-UI text message events.
        
        Returns list of events to yield.
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

    async def run(self, input_data: RunAgentInput) -> AsyncIterator[BaseEvent]:
        """
        Process a run and yield AG-UI events.
        
        This is the main entry point that consumes RunAgentInput and produces
        a stream of AG-UI protocol events.
        
        Args:
            input_data: RunAgentInput with thread_id, run_id, messages
            
        Yields:
            AG-UI events (RunStartedEvent, TextMessageContentEvent, etc.)
        """
        thread_id = input_data.thread_id or str(uuid.uuid4())
        run_id = input_data.run_id or str(uuid.uuid4())
        
        # Clear result data from any previous run
        self._last_result_data = None
        
        try:
            # Emit RUN_STARTED
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=thread_id,
                run_id=run_id,
            )
            
            # Extract user message (don't echo - Dojo handles display)
            user_message = self._extract_user_message(input_data)
            
            if not user_message:
                logger.warning("No user message found in input")
                yield RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id=thread_id,
                    run_id=run_id,
                )
                return
            
            # Run Claude SDK and yield events
            async for event in self._stream_claude_sdk(user_message, thread_id, run_id):
                yield event
            
            # Emit RUN_FINISHED with result data from ResultMessage
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=thread_id,
                run_id=run_id,
                result=self._last_result_data,  # Include metadata from Claude SDK
            )
            
        except Exception as e:
            logger.error(f"Error in run: {e}")
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                thread_id=thread_id,
                run_id=run_id,
                message=str(e),
            )

    def _build_options(self) -> "ClaudeAgentOptions":
        """
        Build ClaudeAgentOptions by merging base options with kwargs.
        
        The merge priority is (highest to lowest):
        1. Explicitly passed kwargs
        2. Base options object attributes  
        3. Sensible defaults
        
        Returns:
            Configured ClaudeAgentOptions instance
        """
        from claude_agent_sdk import ClaudeAgentOptions
        
        # Start with sensible defaults
        merged_kwargs: Dict[str, Any] = {
            "cwd": self.cwd,
            "include_partial_messages": True,
        }
        
        # If base options provided, extract its attributes using model_dump if available
        if self._base_options is not None:
            # Try Pydantic v2 style first
            if hasattr(self._base_options, "model_dump"):
                base_dict = self._base_options.model_dump(exclude_none=True)
                merged_kwargs.update(base_dict)
            # Fall back to Pydantic v1 style
            elif hasattr(self._base_options, "dict"):
                base_dict = self._base_options.dict(exclude_none=True)
                merged_kwargs.update(base_dict)
            # Fall back to __dict__ for plain dataclasses/objects
            elif hasattr(self._base_options, "__dict__"):
                for key, value in self._base_options.__dict__.items():
                    if not key.startswith("_") and value is not None:
                        merged_kwargs[key] = value
        
        # Override with explicitly passed kwargs
        for key, value in self._options_kwargs.items():
            if value is not None:
                # Handle system_prompt conversion to dict format if string
                if key == "system_prompt" and isinstance(value, str):
                    merged_kwargs[key] = {"type": "text", "text": value}
                else:
                    merged_kwargs[key] = value
        
        # Remove api_key from options kwargs (handled via environment variable)
        merged_kwargs.pop("api_key", None)
        
        # Create the options object
        return ClaudeAgentOptions(**merged_kwargs)

    async def _stream_claude_sdk(
        self, prompt: str, thread_id: str, run_id: str
    ) -> AsyncIterator[BaseEvent]:
        """
        Execute the Claude SDK with the given prompt and yield AG-UI events.
        
        Args:
            prompt: The user prompt to send to Claude
            thread_id: AG-UI thread identifier
            run_id: AG-UI run identifier
        """
        # Per-run state (local to this invocation)
        current_message_id: Optional[str] = None
        in_thinking_block: bool = False  # Track if we're inside a thinking content block
        has_streamed_text: bool = False  # Track if we've streamed any text content
        
        if not self.api_key:
            raise RuntimeError("ANTHROPIC_API_KEY must be set")
        
        # Set environment variable for SDK
        os.environ['ANTHROPIC_API_KEY'] = self.api_key
        
        # Import Claude SDK (after setting env var)
        from claude_agent_sdk import ClaudeSDKClient
        from claude_agent_sdk import (
            AssistantMessage,
            UserMessage,
            SystemMessage,
            ResultMessage,
            TextBlock,
            ThinkingBlock,
            ToolUseBlock,
            ToolResultBlock,
        )
        from claude_agent_sdk.types import StreamEvent
        
        # Build options dynamically from base options + kwargs
        options = self._build_options()
        
        # Create client
        logger.debug("Creating ClaudeSDKClient...")
        client = ClaudeSDKClient(options=options)
        
        try:
            # Store client reference for interrupt support
            self._active_client = client
            
            # Connect to SDK
            logger.debug("Connecting to Claude SDK...")
            await client.connect()
            logger.debug("Connected successfully!")
            
            # Use thread_id as session_id for conversation continuity
            # Claude SDK manages separate conversation state per session_id
            session_id = thread_id  # thread_id is guaranteed non-None from run()
            logger.debug(f"Sending query to Claude SDK (session_id={session_id[:8]}...)...")
            await client.query(prompt, session_id=session_id)
            logger.debug("Query sent, waiting for response stream...")
            
            # Process response stream
            message_count = 0
            
            async for message in client.receive_response():
                message_count += 1
                logger.debug(f"[ClaudeSDKClient Message #{message_count}]: {message}")
                
                # Handle StreamEvent for real-time streaming chunks
                if isinstance(message, StreamEvent):
                    event_data = message.event
                    event_type = event_data.get('type')
                    
                    if event_type == 'message_start':
                        current_message_id = str(uuid.uuid4())
                        logger.debug(f"Emitting TEXT_MESSAGE_START (message_id={current_message_id[:8]}...)")
                        yield TextMessageStartEvent(
                            type=EventType.TEXT_MESSAGE_START,
                            thread_id=thread_id,
                            run_id=run_id,
                            message_id=current_message_id,
                            role="assistant",
                        )
                    
                    elif event_type == 'content_block_delta':
                        delta_data = event_data.get('delta', {})
                        delta_type = delta_data.get('type', '')
                        
                        if delta_type == 'text_delta':
                            text_chunk = delta_data.get('text', '')
                            if text_chunk and current_message_id:
                                has_streamed_text = True
                                yield TextMessageContentEvent(
                                    type=EventType.TEXT_MESSAGE_CONTENT,
                                    thread_id=thread_id,
                                    run_id=run_id,
                                    message_id=current_message_id,
                                    delta=text_chunk,
                                )
                        elif delta_type == 'thinking_delta':
                            # Handle streaming thinking content
                            thinking_chunk = delta_data.get('thinking', '')
                            if thinking_chunk:
                                yield ThinkingTextMessageContentEvent(
                                    type=EventType.THINKING_TEXT_MESSAGE_CONTENT,
                                    delta=thinking_chunk,
                                )
                    
                    elif event_type == 'content_block_start':
                        block_data = event_data.get('content_block', {})
                        block_type = block_data.get('type', '')
                        if block_type == 'thinking':
                            in_thinking_block = True
                            yield ThinkingTextMessageStartEvent(
                                type=EventType.THINKING_TEXT_MESSAGE_START,
                            )
                    
                    elif event_type == 'content_block_stop':
                        # Close thinking block if we were in one
                        if in_thinking_block:
                            in_thinking_block = False
                            yield ThinkingTextMessageEndEvent(
                                type=EventType.THINKING_TEXT_MESSAGE_END,
                            )
                    
                    elif event_type == 'message_stop':
                        # End the current text message if we have one
                        if current_message_id:
                            yield TextMessageEndEvent(
                                type=EventType.TEXT_MESSAGE_END,
                                thread_id=thread_id,
                                run_id=run_id,
                                message_id=current_message_id,
                            )
                            current_message_id = None
                    
                    elif event_type == 'message_delta':
                        # Handle message-level delta (e.g., stop_reason, usage)
                        delta_data = event_data.get('delta', {})
                        stop_reason = delta_data.get('stop_reason')
                        if stop_reason:
                            logger.debug(f"Message stop_reason: {stop_reason}")
                    
                    continue
                
                # Handle complete messages
                if isinstance(message, (AssistantMessage, UserMessage)):
                    # Process all blocks in the message
                    for block in getattr(message, 'content', []) or []:
                        if isinstance(block, TextBlock):
                            # TextBlock content is already streamed via text_delta events
                            # Skip to avoid duplicates
                            text_piece = getattr(block, 'text', None)
                            if text_piece:
                                logger.debug(f"TextBlock received (already streamed), length={len(text_piece)}")
                        
                        elif isinstance(block, ToolUseBlock):
                            tool_name = getattr(block, 'name', '') or 'unknown'
                            tool_input = getattr(block, 'input', {}) or {}
                            tool_id = getattr(block, 'id', None) or str(uuid.uuid4())
                            parent_tool_use_id = getattr(message, 'parent_tool_use_id', None)
                            
                            logger.debug(f"ToolUseBlock detected: {tool_name}")
                            
                            yield ToolCallStartEvent(
                                type=EventType.TOOL_CALL_START,
                                thread_id=thread_id,
                                run_id=run_id,
                                tool_call_id=tool_id,
                                tool_call_name=tool_name,
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
                        
                        elif isinstance(block, ToolResultBlock):
                            tool_use_id = getattr(block, 'tool_use_id', None)
                            content = getattr(block, 'content', None)
                            is_error = getattr(block, 'is_error', None)
                            # ToolResultBlock only has: tool_use_id, content, is_error
                            result_content = content
                            
                            if result_content is not None:
                                try:
                                    result_str = json.dumps(result_content)
                                except (TypeError, ValueError):
                                    result_str = str(result_content)
                            else:
                                result_str = ""
                            
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
                                    # error=is_error,  # Not supported in AG-UI Python SDK (would go here)
                                )
                        
                        # ThinkingBlock currently does not emit from the claude-agent-sdk, this may change in the future.
                        elif isinstance(block, ThinkingBlock):
                            thinking_text = getattr(block, 'thinking', '')
                            signature = getattr(block, 'signature', '')
                            
                            # Emit proper ThinkingTextMessage events for thinking blocks
                            if thinking_text:
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
                            
                            # Also emit signature as custom event if present
                            if signature:
                                yield CustomEvent(
                                    type=EventType.CUSTOM,
                                    thread_id=thread_id,
                                    run_id=run_id,
                                    name="thinking_signature",
                                    value={"signature": signature},
                                )
                
                elif isinstance(message, SystemMessage):
                    # SystemMessage has subtype and data attributes
                    subtype = getattr(message, 'subtype', '')
                    data = getattr(message, 'data', {}) or {}
                    
                  
                    # Extract message content from data dict
                    if data:
                        msg_text = data.get('message') or data.get('text') or str(data)
                    else:
                        msg_text = ''
                    
                    if msg_text:
                        logger.debug(f"SystemMessage: subtype={subtype}")
                        # Emit as text message events with role="system"
                        for evt in self._emit_system_message(thread_id, run_id, msg_text):
                            yield evt
                
                elif isinstance(message, ResultMessage):
                    # ResultMessage contains metadata (tokens, cost, duration) and optional result text
                    is_error = getattr(message, 'is_error', None)
                    result_text = getattr(message, 'result', None)
                    
                    # Capture result data for RunFinished event
                    self._last_result_data = {
                        "is_error": is_error,
                        "result": result_text,
                        "duration_ms": getattr(message, 'duration_ms', None),
                        "duration_api_ms": getattr(message, 'duration_api_ms', None),
                        "num_turns": getattr(message, 'num_turns', None),
                        "total_cost_usd": getattr(message, 'total_cost_usd', None),
                        "usage": getattr(message, 'usage', None),
                        "structured_output": getattr(message, 'structured_output', None),
                    }
                    
                    # Only display result text if we haven't streamed text (avoids duplicates)
                    if not has_streamed_text:
                        result_msg_id = str(uuid.uuid4())
                        yield TextMessageStartEvent(
                            type=EventType.TEXT_MESSAGE_START,
                            thread_id=thread_id,
                            run_id=run_id,
                            message_id=result_msg_id,
                            role="assistant",
                        )
                        yield TextMessageContentEvent(
                            type=EventType.TEXT_MESSAGE_CONTENT,
                            thread_id=thread_id,
                            run_id=run_id,
                            message_id=result_msg_id,
                            delta=result_text,
                        )
                        yield TextMessageEndEvent(
                            type=EventType.TEXT_MESSAGE_END,
                            thread_id=thread_id,
                            run_id=run_id,
                            message_id=result_msg_id,
                        )
            
            logger.debug(f"Response stream completed ({message_count} messages)")
            logger.debug(f"Conversation state saved in .claude/ (session_id={session_id[:8]})")
        
        # Errors propagate to run() which emits RunErrorEvent
            
        finally:
            # Clear active client reference
            self._active_client = None
            
            # Always disconnect client
            if client is not None:
                logger.debug("Disconnecting Claude SDK client")
                await client.disconnect()
    
    async def interrupt(self) -> None:
        """
        Interrupt the active Claude SDK execution.
        """
        if self._active_client is None:
            logger.warning("Interrupt requested but no active client")
            return
        
        try:
            logger.debug("Sending interrupt signal to Claude SDK...")
            await self._active_client.interrupt()
            logger.debug("Interrupt signal sent successfully")
        except Exception as e:
            logger.error(f"Failed to interrupt Claude SDK: {e}")

