"""
Claude Agent SDK adapter for AG-UI protocol.

This adapter wraps the Claude Agent SDK and produces AG-UI protocol events,
enabling Claude-powered agents to work with any AG-UI compatible frontend.
"""

import os
import logging
import json
import uuid
from typing import AsyncIterator, Optional, List, Dict, Any, Union, TYPE_CHECKING

# AG-UI Protocol Events
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

# Type checking imports for Claude SDK types
if TYPE_CHECKING:
    from claude_agent_sdk import ClaudeAgentOptions

# Import helper functions and constants
from .utils import (
    process_messages,
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
    
    This adapter accepts Claude SDK configuration via the `options` parameter.
    Follows the LangGraph pattern: accepts ClaudeAgentOptions object OR dict for convenience.
    
    Configuration options:
    1. ClaudeAgentOptions object (fully typed, recommended for production)
    2. dict with option parameters (convenient for examples/prototyping)
    3. None (uses sensible defaults)
    
    Session Management:
        Claude SDK maintains conversation state via session_id mapped to .claude/ directory.
        This adapter tracks session_ids per thread_id for proper resumption across runs.
        
        For production deployment with persistent sessions, mount the .claude/ directory
        as a persistent volume. See: https://platform.claude.com/docs/en/agent-sdk/hosting
    
    RunAgentInput Field Handling:
        - thread_id: Mapped to Claude SDK session_id for conversation continuity
        - run_id: Used for event correlation in AG-UI protocol
        - messages: All validated; last user message sent to SDK (SDK manages history)
        - tools: Dynamically added as "ag_ui" MCP server (stub implementations for frontend tools)
        - context: Appended to system_prompt for agent awareness
        - state: Appended to system_prompt + ag_ui_update_state tool created for bidirectional sync
        - parent_run_id: Passed through to RUN_STARTED for branching/lineage tracking
        - forwarded_props: Per-run option overrides (see ALLOWED_FORWARDED_PROPS for whitelist)
    
    Frontend Tool Execution (Human-in-the-Loop Pattern):
        When Claude calls a frontend tool (tool name matches input.tools):
        1. Backend emits TOOL_CALL_START/ARGS/END events (streaming arguments)
        2. Backend HALTS stream immediately after TOOL_CALL_END (Strands pattern)
        3. Client executes tool handler with complete arguments
        4. Client sends ToolMessage back in NEXT RunAgentInput.messages
        5. Backend resumes conversation with tool result
        
        This pause-and-resume pattern enables proper human-in-the-loop workflows
        where frontend tools can update UI state, request user input, etc.
    
    Forwarded Props Support:
        Per-run overrides for execution control without changing agent identity.
        Whitelisted keys include: resume, fork_session, model, temperature, max_tokens,
        max_thinking_tokens, max_turns, max_budget_usd, output_format, etc.
        
        Example:
            RunAgentInput(
                forwarded_props={
                    "model": "claude-opus-4",
                    "max_turns": 5,
                    "temperature": 0.8
                }
            )
    
    State Management:
        When state is provided in RunAgentInput:
        1. Initial state emitted as STATE_SNAPSHOT event
        2. State appended to system_prompt so Claude can see current values
        3. ag_ui_update_state tool created dynamically
        4. When Claude calls ag_ui_update_state, we emit STATE_SNAPSHOT with new values
        5. Client receives STATE_SNAPSHOT and updates UI accordingly
        
        This enables bidirectional state sync similar to LangGraph/CopilotKit patterns.
    
    Example:
        # Using dict (convenient for examples)
        adapter = ClaudeAgentAdapter(
            name="my_agent",
            description="A helpful assistant",
            options={
                "model": "claude-haiku-4-5",
                "cwd": "/my/project",
                "system_prompt": "You are helpful",
                "permission_mode": "acceptEdits",
                "allowed_tools": ["Read", "Write", "Bash"],
            }
        )
        
        # Using ClaudeAgentOptions (recommended for production - fully typed!)
        from claude_agent_sdk import ClaudeAgentOptions
        options = ClaudeAgentOptions(
            model="claude-haiku-4-5",
            cwd="/my/project",
            system_prompt="You are helpful",
            permission_mode="acceptEdits",
            sandbox={"enabled": True},
        )
        adapter = ClaudeAgentAdapter(
            name="my_agent",
            options=options
        )
    """

    def __init__(
        self,
        name: str,
        options: Union["ClaudeAgentOptions", dict, None] = None,
        description: str = "",
    ):
        """
        Initialize the Claude Agent adapter.
        
        Follows the LangGraph pattern: accepts a typed ClaudeAgentOptions object
        OR a dict with option parameters (for convenience without losing type safety).
        
        Args:
            name: Name of the agent (for identification and logging).
            options: Claude SDK configuration. Can be:
                    - ClaudeAgentOptions instance (fully typed, recommended)
                    - dict with ClaudeAgentOptions fields (convenience)
                    - None (uses defaults)
                    
                    Common options (when using dict):
                    - model: str - Claude model (e.g., "claude-haiku-4-5")
                    - system_prompt: str | dict - Custom system prompt
                    - cwd: str - Working directory
                    - mcp_servers: dict - MCP servers mapping
                    - allowed_tools: list[str] - Tool names to allow
                    - permission_mode: str - "default" | "acceptEdits" | etc
                    - max_tokens: int - Response length limit
                    - temperature: float - Sampling temperature
                    
                    See full ClaudeAgentOptions docs:
                     https://platform.claude.com/docs/en/agent-sdk/python
                    
            description: Optional description of the agent.
        """
        # Agent metadata
        self.name = name
        self.description = description
        
        # Store the options (ClaudeAgentOptions object OR dict)
        self._options = options
        
        # Extract api_key for setup
        if isinstance(options, dict):
            self.api_key = options.get("api_key") or os.getenv("ANTHROPIC_API_KEY", "")
        elif options is not None and hasattr(options, "api_key"):
            self.api_key = getattr(options, "api_key", None) or os.getenv("ANTHROPIC_API_KEY", "")
        else:
            self.api_key = os.getenv("ANTHROPIC_API_KEY", "")
        
        # Track Claude SDK session IDs per thread (for session resumption)
        # Maps thread_id -> session_id returned by Claude SDK
        self._session_ids_by_thread: Dict[str, str] = {}
        
        # Active client reference (for interrupt support)
        self._active_client: Optional[Any] = None
        
        # Result data from last run (for RunFinished event)
        self._last_result_data: Optional[Dict[str, Any]] = None

        # Current state tracking per run (for state management)
        self._current_state: Optional[Any] = None

    async def run(self, input_data: RunAgentInput) -> AsyncIterator[BaseEvent]:
        """
        Process a run and yield AG-UI events.
        
        This is the main entry point that consumes RunAgentInput and produces
        a stream of AG-UI protocol events.
        
        Args:
            input_data: RunAgentInput with thread_id, run_id, messages, tools,
                        context, state, forwarded_props, etc.
            
        Yields:
            AG-UI events (RunStartedEvent, TextMessageContentEvent, etc.)
        """
        thread_id = input_data.thread_id or str(uuid.uuid4())
        run_id = input_data.run_id or str(uuid.uuid4())
        
        # Clear result data from any previous run
        self._last_result_data = None
        
        # Initialize state tracking for this run
        self._current_state = input_data.state
        
        try:
            # Log parent_run_id if provided (for branching/time travel tracking)
            if input_data.parent_run_id:
                logger.debug(
                    f"Run {run_id[:8]}... is branched from parent run {input_data.parent_run_id[:8]}..."
                )
            
            # Emit RUN_STARTED with input capture (following LangGraph pattern)
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=thread_id,
                run_id=run_id,
                parent_run_id=input_data.parent_run_id,  # Pass through for lineage tracking
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
            
            # Process all messages and extract user message
            user_message, _ = process_messages(input_data)
            
            # Extract frontend tool names for halt detection (like Strands pattern)
            frontend_tool_names = set(extract_tool_names(input_data.tools)) if input_data.tools else set()
            if frontend_tool_names:
                logger.debug(f"Frontend tools detected: {frontend_tool_names}")
            
            # Log tools from input - these will be dynamically added as MCP server
            if input_data.tools:
                tool_names = extract_tool_names(input_data.tools)
                logger.debug(
                    f"Client provided {len(input_data.tools)} frontend tools: {tool_names}. "
                    f"Creating dynamic ag_ui_frontend MCP server."
                )
            
            # Log state from input (for debugging - Claude SDK manages state internally)
            if input_data.state:
                logger.debug(
                    f"Client provided state with keys: {list(input_data.state.keys()) if isinstance(input_data.state, dict) else 'non-dict state'}. "
                    f"Note: Claude SDK manages state internally via session_id."
                )
            
            # Log context from input (for debugging - not used by Claude SDK)
            if input_data.context:
                logger.debug(
                    f"Client provided {len(input_data.context)} context items. "
                    f"Note: Claude SDK manages context via session history."
                )
            
            # Log forwarded_props for debugging
            if input_data.forwarded_props:
                logger.debug(
                    f"Received forwarded_props: {input_data.forwarded_props}"
                )
            
            if not user_message:
                logger.warning("No user message found in input")
                yield RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id=thread_id,
                    run_id=run_id,
                )
                return
            
            # Emit initial state snapshot if provided
            if input_data.state:
                yield StateSnapshotEvent(
                    type=EventType.STATE_SNAPSHOT,
                    snapshot=input_data.state
                )
            
            # Run Claude SDK and yield events
            async for event in self._stream_claude_sdk(
                user_message, thread_id, run_id, input_data, frontend_tool_names
            ):
                yield event
            
            # Emit RUN_FINISHED with result data from ResultMessage
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=thread_id,
                run_id=run_id,
                result=self._last_result_data,
            )
            
        except Exception as e:
            logger.error(f"Error in run: {e}")
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                thread_id=thread_id,
                run_id=run_id,
                message=str(e),
            )

    def _build_options(self, input_data: Optional[RunAgentInput] = None, thread_id: Optional[str] = None) -> "ClaudeAgentOptions":
        """
        Build ClaudeAgentOptions from stored options (object/dict/None) plus dynamic tools.
        
        Follows LangGraph pattern: handles ClaudeAgentOptions | dict | None.
        
        Args:
            input_data: Optional RunAgentInput for extracting dynamic tools
            thread_id: Optional thread_id for session resumption lookup
        
        Returns:
            Configured ClaudeAgentOptions instance
        """
        from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server
        
        # Start with sensible defaults
        merged_kwargs: Dict[str, Any] = {
            "include_partial_messages": True,
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
        
        # Add session resumption if we have an existing session for this thread
        # resume option tells the Claude SDK to load and continue the previous conversation
        # (session_id on client.query() just labels the session directory, doesn't resume)
        if thread_id:
            existing_session_id = self._session_ids_by_thread.get(thread_id)
            if existing_session_id:
                merged_kwargs["resume"] = existing_session_id
                logger.debug(f"Added resume={existing_session_id[:8]}... for thread {thread_id[:8]}...")
        
        # Create the options object
        logger.debug(f"Creating ClaudeAgentOptions with merged kwargs: {merged_kwargs}")
        return ClaudeAgentOptions(**merged_kwargs)

    async def _stream_claude_sdk(
        self,
        prompt: str,
        thread_id: str,
        run_id: str,
        input_data: RunAgentInput,
        frontend_tool_names: set[str],
    ) -> AsyncIterator[BaseEvent]:
        """
        Execute the Claude SDK with the given prompt and yield AG-UI events.
        
        Args:
            prompt: The user prompt to send to Claude
            thread_id: AG-UI thread identifier
            run_id: AG-UI run identifier
            input_data: Full RunAgentInput for context
            frontend_tool_names: Set of frontend tool names for halt detection
        """
        # Per-run state (local to this invocation)
        current_message_id: Optional[str] = None
        in_thinking_block: bool = False  # Track if we're inside a thinking content block
        has_streamed_text: bool = False  # Track if we've streamed any text content
        
        # Tool call streaming state
        current_tool_call_id: Optional[str] = None
        current_tool_call_name: Optional[str] = None
        current_tool_display_name: Optional[str] = None  # Unprefixed name for frontend matching
        accumulated_tool_json: str = ""  # Accumulate partial JSON for tool arguments
        
        # Track which tools we've already emitted START for (to avoid duplicates)
        processed_tool_ids: set = set()
        
        # Frontend tool halt flag (like Strands pattern)
        halt_event_stream: bool = False  # Set to True when frontend tool completes
        
        # ── MESSAGES_SNAPSHOT accumulation ──
        # All message types go here. At the end we emit:
        #   MESSAGES_SNAPSHOT = [...input_data.messages, ...run_messages]
        run_messages: List[Any] = []
        pending_msg: Optional[Dict[str, Any]] = None
        accumulated_thinking_text = ""

        def upsert_message(msg):
            """Upsert a message: replace if same ID exists, otherwise append."""
            msg_id = getattr(msg, "id", None)
            for i, m in enumerate(run_messages):
                if getattr(m, "id", None) == msg_id:
                    run_messages[i] = msg
                    return
            run_messages.append(msg)

        def flush_pending_msg():
            """Flush pendingMsg → run_messages (upsert so streaming version wins over fallback)."""
            nonlocal pending_msg
            if pending_msg is None:
                return
            if pending_msg["content"] or pending_msg["tool_calls"]:
                upsert_message(
                    AguiAssistantMessage(
                        id=pending_msg["id"],
                        role="assistant",
                        content=pending_msg["content"] or None,
                        tool_calls=pending_msg["tool_calls"] or None,
                    )
                )
            pending_msg = None
        
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
        
        # Build options dynamically from base options + kwargs + input.tools + session resume
        options = self._build_options(input_data=input_data, thread_id=thread_id)
        
        # Create client
        logger.debug("Creating ClaudeSDKClient...")     
        client = ClaudeSDKClient(options=options)
        
        # Store reference for interrupt support
        self._active_client = client
        
        try:
            # Connect to SDK
            logger.debug("Connecting to Claude SDK...")
            await client.connect()
            logger.debug("Connected successfully!")
            
            # Use existing session_id as label if we have one, otherwise thread_id
            existing_session_id = self._session_ids_by_thread.get(thread_id)
            session_label = existing_session_id or thread_id
            
            if existing_session_id:
                logger.debug(
                    f"Resuming session {existing_session_id[:8]}... for thread {thread_id[:8]}..."
                )
            else:
                logger.debug(
                    f"Starting new session for thread {thread_id[:8]}... "
                    f"(message_count={len(input_data.messages)})"
                )
            
            await client.query(prompt, session_id=session_label)
            
            logger.debug("Query sent, waiting for response stream...")
            
            # Process response stream
            message_count = 0
            
            async for message in client.receive_response():
                message_count += 1
                
                # If we've halted due to frontend tool, break out of loop (interrupt already called)
                if halt_event_stream:
                    logger.debug(f"[ClaudeSDKClient Message #{message_count}]: Halted - breaking stream loop")
                    break  # Stop consuming, interrupt() already stopped generation
                
                logger.debug(f"[ClaudeSDKClient Message #{message_count}]: {message}")
                
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
                            # Handle streaming tool arguments
                            partial_json = delta_data.get('partial_json', '')
                            if partial_json and current_tool_call_id:
                                # Accumulate JSON for potential parsing
                                accumulated_tool_json += partial_json
                                
                                # Emit TOOL_CALL_ARGS with the delta
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
                            # Tool call starting - emit TOOL_CALL_START
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
                                    tool_call_name=current_tool_display_name,  # Use unprefixed name for frontend matching!
                                    parent_message_id=current_message_id,  # Link to parent message
                                )
                    
                    elif event_type == 'content_block_stop':
                        if in_thinking_block:
                            in_thinking_block = False
                            yield ThinkingTextMessageEndEvent(type=EventType.THINKING_TEXT_MESSAGE_END)
                            yield ThinkingEndEvent(type=EventType.THINKING_END)

                            # Persist thinking content
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
                                # Parse accumulated JSON and emit STATE_SNAPSHOT
                                try:
                                    state_updates = json.loads(accumulated_tool_json)
                                    
                                    # Extract state_updates from the parsed args
                                    if isinstance(state_updates, dict):
                                        updates = state_updates.get("state_updates", state_updates)
                                        
                                        # Parse nested JSON string if needed
                                        if isinstance(updates, str):
                                            updates = json.loads(updates)
                                        
                                        # Update current state
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

                            # Check if this is a frontend tool (using unprefixed name for comparison)
                            # Frontend tools should halt the stream so client can execute handler
                            is_frontend_tool = current_tool_display_name in frontend_tool_names
                            
                            if is_frontend_tool:
                                # Flush before halt (message_stop won't fire after interrupt)
                                flush_pending_msg()

                                # Emit TOOL_CALL_END for frontend tool (client needs this to know call is complete)
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

                                if self._active_client:
                                    try:
                                        await self._active_client.interrupt()
                                    except Exception as e:
                                        logger.warning(f"Failed to interrupt stream: {e}")
                                
                                halt_event_stream = True
                                # Continue consuming remaining events for cleanup
                                continue
                            
                            # For regular backend tools, DON'T emit TOOL_CALL_END here
                            # Backend tools will have ToolResultBlock which emits END + RESULT
                            
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
                        # Handle message-level delta (e.g., stop_reason, usage)
                        delta_data = event_data.get('delta', {})
                        stop_reason = delta_data.get('stop_reason')
                        if stop_reason:
                            logger.debug(f"Message stop_reason: {stop_reason}")
                    
                    continue
                
                # Handle complete messages
                if isinstance(message, (AssistantMessage, UserMessage)):
                    # Accumulate from complete SDK message (fallback path).
                    # Uses the streaming ID so flush_pending_msg() can replace it
                    # with the richer streaming version (which has tool_calls).
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
                    
                    if subtype == 'init' and data:
                        returned_session_id = data.get('session_id')
                        if returned_session_id:
                            self._session_ids_by_thread[thread_id] = returned_session_id
                  
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

