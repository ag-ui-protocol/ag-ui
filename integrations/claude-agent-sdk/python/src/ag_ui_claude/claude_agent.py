"""Main ClaudeAgent implementation for bridging AG-UI Protocol with Claude Agent SDK."""

from typing import Optional, Dict, Callable, Any, AsyncGenerator, List
import asyncio
import json
import logging
import time

try:
    from ag_ui.core import (
        RunAgentInput, BaseEvent, EventType,
        RunStartedEvent, RunFinishedEvent, RunErrorEvent,
        ToolCallEndEvent, SystemMessage, ToolCallResultEvent
    )
except ImportError:
    # Type checking fallback - actual dependency will be available at runtime
    pass

# Claude Agent SDK imports
try:
    from claude_agent_sdk import (
        ClaudeSDKClient,
        ClaudeAgentOptions,
        query as claude_query,
        Message,
        AssistantMessage,
        UserMessage as ClaudeUserMessage,
        SystemMessage as ClaudeSystemMessage,
        ResultMessage,
        TextBlock,
        ToolUseBlock,
        ToolResultBlock,
        ThinkingBlock,
    )
except ImportError:
    # Type checking fallback - actual dependency will be available at runtime
    ClaudeSDKClient = None
    ClaudeAgentOptions = None
    claude_query = None

from .event_translator import EventTranslator
from .session_manager import SessionManager
from .execution_state import ExecutionState

logger = logging.getLogger(__name__)


class ClaudeAgent:
    """Middleware to bridge AG-UI Protocol with Claude Agent SDK.
    
    This agent translates between the AG-UI protocol events and Claude SDK responses,
    managing sessions, state, and the lifecycle of Claude agents.
    
    Note: This implementation is a template based on common patterns.
    Adjust based on actual Claude Agent SDK API documentation.
    """
    
    def __init__(
        self,
        # Claude SDK configuration
        api_key: Optional[str] = None,
        use_persistent_sessions: bool = True,  # Use ClaudeSDKClient vs query() mode
        
        # App identification
        app_name: Optional[str] = None,
        session_timeout_seconds: Optional[int] = 1200,
        app_name_extractor: Optional[Callable[[RunAgentInput], str]] = None,
        
        # User identification
        user_id: Optional[str] = None,
        user_id_extractor: Optional[Callable[[RunAgentInput], str]] = None,
        
        # Configuration
        execution_timeout_seconds: int = 600,  # 10 minutes
        tool_timeout_seconds: int = 300,  # 5 minutes
        max_concurrent_executions: int = 10,
        
        # Session cleanup configuration
        cleanup_interval_seconds: int = 300,  # 5 minutes default
        
        # Claude Agent SDK options
        claude_options: Optional[Any] = None,  # ClaudeAgentOptions instance
        **claude_kwargs  # Additional options for ClaudeAgentOptions
    ):
        """Initialize the ClaudeAgent.
        
        Args:
            api_key: Claude API key (if None, Claude SDK will use ANTHROPIC_API_KEY env var)
            use_persistent_sessions: Use ClaudeSDKClient for persistent sessions, or query() for stateless
            app_name: Static application name for all requests
            app_name_extractor: Function to extract app name dynamically from input
            user_id: Static user ID for all requests
            user_id_extractor: Function to extract user ID dynamically from input
            execution_timeout_seconds: Timeout for entire execution
            tool_timeout_seconds: Timeout for individual tool calls
            max_concurrent_executions: Maximum concurrent background executions
            cleanup_interval_seconds: Interval between session cleanup cycles
            claude_options: ClaudeAgentOptions instance (if None, will create from kwargs)
            **claude_kwargs: Additional options for ClaudeAgentOptions (if claude_options is None)
        """
        if app_name and app_name_extractor:
            raise ValueError("Cannot specify both 'app_name' and 'app_name_extractor'")
        
        if user_id and user_id_extractor:
            raise ValueError("Cannot specify both 'user_id' and 'user_id_extractor'")
        
        # Claude SDK client configuration
        self._api_key = api_key
        self._use_persistent_sessions = use_persistent_sessions
        
        # Create ClaudeAgentOptions if not provided
        if claude_options is None:
            if ClaudeAgentOptions:
                self._claude_options = ClaudeAgentOptions(**claude_kwargs)
            else:
                self._claude_options = None
                logger.warning("ClaudeAgentOptions not available - install claude-agent-sdk")
        else:
            self._claude_options = claude_options
        
        # Store tools for dynamic addition per request
        self._default_tools: List[Any] = []
        
        # App/user identification
        self._static_app_name = app_name
        self._app_name_extractor = app_name_extractor
        self._static_user_id = user_id
        self._user_id_extractor = user_id_extractor
        
        # Session management
        self._session_manager = SessionManager.get_instance(
            session_timeout_seconds=session_timeout_seconds,
            cleanup_interval_seconds=cleanup_interval_seconds,
            max_sessions_per_user=None,
            auto_cleanup=True
        )
        
        # Execution tracking
        self._active_executions: Dict[str, ExecutionState] = {}
        self._execution_timeout = execution_timeout_seconds
        self._tool_timeout = tool_timeout_seconds
        self._max_concurrent = max_concurrent_executions
        self._execution_lock = asyncio.Lock()
        
        # Session lookup cache
        self._session_lookup_cache: Dict[str, Dict[str, str]] = {}
        
        logger.info(
            f"Initialized ClaudeAgent - "
            f"persistent_sessions: {use_persistent_sessions}"
        )
    
    def _get_app_name(self, input: RunAgentInput) -> str:
        """Resolve app name with clear precedence."""
        if self._static_app_name:
            return self._static_app_name
        elif self._app_name_extractor:
            return self._app_name_extractor(input)
        else:
            return "claude-agent"
    
    def _get_user_id(self, input: RunAgentInput) -> str:
        """Resolve user ID with clear precedence."""
        if self._static_user_id:
            return self._static_user_id
        elif self._user_id_extractor:
            return self._user_id_extractor(input)
        else:
            return f"thread_user_{input.thread_id}"
    
    async def run(self, input: RunAgentInput) -> AsyncGenerator[BaseEvent, None]:
        """Run the Claude agent with client-side tool support.
        
        Args:
            input: The AG-UI run input
            
        Yields:
            AG-UI protocol events
        """
        # Get unseen messages
        unseen_messages = await self._get_unseen_messages(input)
        
        if not unseen_messages:
            # No unseen messages - start new execution
            async for event in self._start_new_execution(input):
                yield event
            return
        
        # Process messages in batches
        index = 0
        total_unseen = len(unseen_messages)
        app_name = self._get_app_name(input)
        
        while index < total_unseen:
            current = unseen_messages[index]
            role = getattr(current, "role", None)
            
            if role == "tool":
                # Tool result batch
                tool_batch: List[Any] = []
                while index < total_unseen and getattr(unseen_messages[index], "role", None) == "tool":
                    tool_batch.append(unseen_messages[index])
                    index += 1
                
                async for event in self._handle_tool_result_submission(
                    input,
                    tool_messages=tool_batch
                ):
                    yield event
            else:
                # Regular message batch
                message_batch: List[Any] = []
                assistant_message_ids: List[str] = []
                processed_message_ids: List[str] = []
                
                while index < total_unseen and getattr(unseen_messages[index], "role", None) != "tool":
                    candidate = unseen_messages[index]
                    candidate_role = getattr(candidate, "role", None)
                    
                    message_id = getattr(candidate, "id", None)
                    if message_id:
                        if candidate_role == "assistant":
                            assistant_message_ids.append(message_id)
                        processed_message_ids.append(message_id)
                    
                    if candidate_role != "assistant":
                        message_batch.append(candidate)
                    
                    index += 1
                
                # Mark all processed messages (including user messages)
                if processed_message_ids:
                    self._session_manager.mark_messages_processed(
                        app_name,
                        input.thread_id,
                        set(processed_message_ids)
                    )
                
                if message_batch:
                    async for event in self._start_new_execution(input, message_batch=message_batch):
                        yield event
    
    async def _get_unseen_messages(self, input: RunAgentInput) -> List[Any]:
        """Return messages that have not yet been processed for this session."""
        if not input.messages:
            return []
        
        app_name = self._get_app_name(input)
        session_id = input.thread_id
        processed_ids = self._session_manager.get_processed_message_ids(app_name, session_id)
        
        unseen_reversed: List[Any] = []
        for message in reversed(input.messages):
            message_id = getattr(message, "id", None)
            if message_id and message_id in processed_ids:
                break
            unseen_reversed.append(message)
        
        unseen_reversed.reverse()
        return unseen_reversed
    
    async def _is_tool_result_submission(
        self,
        input: RunAgentInput,
        unseen_messages: Optional[List[Any]] = None,
    ) -> bool:
        """Check if the current input is a tool result submission.
        
        Args:
            input: RunAgentInput to check
            unseen_messages: Optional pre-computed unseen messages
            
        Returns:
            True if this is a tool result submission, False otherwise
        """
        unseen_messages = unseen_messages if unseen_messages is not None else await self._get_unseen_messages(input)
        if not unseen_messages:
            return False
        last_message = unseen_messages[-1]
        # Check if the last message is a ToolMessage
        return hasattr(last_message, "role") and last_message.role == "tool"
    
    async def _handle_tool_result_submission(
        self,
        input: RunAgentInput,
        tool_messages: List[Any]
    ) -> AsyncGenerator[BaseEvent, None]:
        """Handle tool result submission for existing execution."""
        # Extract tool results
        tool_results = await self._extract_tool_results(input, tool_messages)
        
        if not tool_results:
            logger.error(f"Tool result submission without tool results for thread {input.thread_id}")
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message="No tool results found in submission",
                code="NO_TOOL_RESULTS"
            )
            return
        
        # Start new execution with tool results
        async for event in self._start_new_execution(
            input,
            tool_results=tool_results,
            message_batch=tool_messages
        ):
            yield event
    
    async def _extract_tool_results(
        self,
        input: RunAgentInput,
        candidate_messages: List[Any]
    ) -> List[Dict]:
        """Extract tool messages with their names from input."""
        tool_call_map = {}
        for message in input.messages:
            if hasattr(message, 'tool_calls') and message.tool_calls:
                for tool_call in message.tool_calls:
                    tool_call_map[tool_call.id] = tool_call.function.name
        
        extracted_results: List[Dict] = []
        for message in candidate_messages:
            if hasattr(message, 'role') and message.role == "tool":
                tool_name = tool_call_map.get(getattr(message, 'tool_call_id', None), "unknown")
                extracted_results.append({
                    'tool_name': tool_name,
                    'message': message
                })
        
        return extracted_results
    
    async def _start_new_execution(
        self,
        input: RunAgentInput,
        *,
        tool_results: Optional[List[Dict]] = None,
        message_batch: Optional[List[Any]] = None,
    ) -> AsyncGenerator[BaseEvent, None]:
        """Start a new Claude execution with tool support."""
        try:
            # Emit RUN_STARTED
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input.thread_id,
                run_id=input.run_id
            )
            
            # Check concurrent execution limit
            async with self._execution_lock:
                if len(self._active_executions) >= self._max_concurrent:
                    await self._cleanup_stale_executions()
                    if len(self._active_executions) >= self._max_concurrent:
                        raise RuntimeError(
                            f"Maximum concurrent executions ({self._max_concurrent}) reached"
                        )
                
                existing_execution = self._active_executions.get(input.thread_id)
            
            # Wait for existing execution if needed
            if existing_execution and not existing_execution.is_complete:
                logger.debug(f"Waiting for existing execution to complete for thread {input.thread_id}")
                try:
                    await existing_execution.task
                except Exception as e:
                    logger.debug(f"Previous execution completed with error: {e}")
            
            # Start background execution
            execution = await self._start_background_execution(
                input,
                tool_results=tool_results,
                message_batch=message_batch,
            )
            
            # Store execution
            async with self._execution_lock:
                self._active_executions[input.thread_id] = execution
            
            # Stream events
            has_tool_calls = False
            tool_call_ids = []
            
            async for event in self._stream_events(execution):
                if isinstance(event, ToolCallEndEvent):
                    has_tool_calls = True
                    tool_call_ids.append(event.tool_call_id)
                
                if isinstance(event, ToolCallResultEvent) and event.tool_call_id in tool_call_ids:
                    tool_call_ids.remove(event.tool_call_id)
                
                yield event
            
            # Track pending tool calls
            if has_tool_calls:
                app_name = self._get_app_name(input)
                user_id = self._get_user_id(input)
                for tool_call_id in tool_call_ids:
                    await self._add_pending_tool_call(input.thread_id, tool_call_id, app_name, user_id)
            
            # Emit RUN_FINISHED
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input.thread_id,
                run_id=input.run_id
            )
            
        except Exception as e:
            logger.error(f"Error in new execution: {e}", exc_info=True)
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=str(e),
                code="EXECUTION_ERROR"
            )
        finally:
            # Clean up execution
            async with self._execution_lock:
                if input.thread_id in self._active_executions:
                    execution = self._active_executions[input.thread_id]
                    execution.is_complete = True
                    has_pending = await self._has_pending_tool_calls(input.thread_id)
                    if not has_pending:
                        del self._active_executions[input.thread_id]
    
    async def _start_background_execution(
        self,
        input: RunAgentInput,
        *,
        tool_results: Optional[List[Dict]] = None,
        message_batch: Optional[List[Any]] = None,
    ) -> ExecutionState:
        """Start Claude execution in background with tool support."""
        event_queue = asyncio.Queue()
        user_id = self._get_user_id(input)
        app_name = self._get_app_name(input)
        
        # Create background task
        task = asyncio.create_task(
            self._run_claude_in_background(
                input=input,
                user_id=user_id,
                app_name=app_name,
                event_queue=event_queue,
                tool_results=tool_results,
                message_batch=message_batch,
            )
        )
        
        return ExecutionState(
            task=task,
            thread_id=input.thread_id,
            event_queue=event_queue
        )
    
    async def _run_claude_in_background(
        self,
        input: RunAgentInput,
        user_id: str,
        app_name: str,
        event_queue: asyncio.Queue,
        tool_results: Optional[List[Dict]] = None,
        message_batch: Optional[List[Any]] = None,
    ):
        """Run Claude SDK in background, emitting events to queue.
        
        TODO: Implement based on actual Claude Agent SDK API.
        This is a template implementation - adjust based on SDK documentation.
        """
        event_translator = EventTranslator()
        
        try:
            # Ensure session exists
            await self._session_manager.get_or_create_session(
                session_id=input.thread_id,
                app_name=app_name,
                user_id=user_id,
                initial_state=input.state
            )
            
            # Update session state
            await self._session_manager.update_session_state(
                input.thread_id,
                app_name,
                user_id,
                input.state
            )
            
            # Get messages to process
            unseen_messages = message_batch if message_batch is not None else await self._get_unseen_messages(input)
            
            # Extract user prompt from messages
            # Claude SDK uses prompt string (for query()) or sends via client.query()
            user_prompt = await self._extract_user_prompt(unseen_messages, tool_results)
            
            if not user_prompt:
                logger.warning("No user prompt found in messages")
                await event_queue.put(
                    RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        message="No user message found",
                        code="NO_USER_MESSAGE"
                    )
                )
                await event_queue.put(None)
                return
            
            # Mark messages as processed before executing
            # Collect all message IDs from unseen messages
            message_ids_to_mark = []
            for msg in unseen_messages:
                msg_id = getattr(msg, "id", None)
                if msg_id:
                    message_ids_to_mark.append(msg_id)
            
            if message_ids_to_mark:
                self._session_manager.mark_messages_processed(
                    app_name,
                    input.thread_id,
                    set(message_ids_to_mark)
                )
            
            # Prepare tools for this request
            request_options = await self._prepare_request_options(input.tools)
            
            # Get or create Claude client
            session_key = self._session_manager._make_session_key(app_name, input.thread_id)
            claude_client = None
            
            # Try to get persistent client if enabled
            if self._use_persistent_sessions:
                try:
                    claude_client = self._get_claude_client(session_key, request_options)
                except Exception as e:
                    logger.warning(f"Failed to get persistent client, falling back to stateless mode: {e}")
                    claude_client = None
            
            # Use client if available and connected, otherwise use stateless mode
            if claude_client and self._use_persistent_sessions:
                try:
                    # For persistent sessions, try to use client
                    async for claude_message in self._call_claude_sdk(claude_client, user_prompt, request_options):
                        # Translate Claude message to AG-UI events
                        async for ag_ui_event in event_translator.translate_claude_message(
                            claude_message,
                            input.thread_id,
                            input.run_id
                        ):
                            await event_queue.put(ag_ui_event)
                except Exception as e:
                    # If persistent client fails, fall back to stateless mode
                    logger.warning(f"Persistent client failed ({e}), falling back to stateless mode")
                    async for claude_message in self._call_claude_sdk(None, user_prompt, request_options):
                        async for ag_ui_event in event_translator.translate_claude_message(
                            claude_message,
                            input.thread_id,
                            input.run_id
                        ):
                            await event_queue.put(ag_ui_event)
            else:
                # Stateless mode - use query() function directly
                async for claude_message in self._call_claude_sdk(None, user_prompt, request_options):
                    async for ag_ui_event in event_translator.translate_claude_message(
                        claude_message,
                        input.thread_id,
                        input.run_id
                    ):
                        await event_queue.put(ag_ui_event)
            
            # Force close any streaming messages
            async for event in event_translator.force_close_streaming_message():
                await event_queue.put(event)
            
            # Send final state snapshot
            final_state = await self._session_manager.get_session_state(
                input.thread_id,
                app_name,
                user_id
            )
            if final_state:
                # TODO: Create state snapshot event if needed
                pass
            
            # Signal completion
            await event_queue.put(None)
            
        except Exception as e:
            logger.error(f"Background execution error: {e}", exc_info=True)
            await event_queue.put(
                RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message=str(e),
                    code="BACKGROUND_EXECUTION_ERROR"
                )
            )
            await event_queue.put(None)
    
    async def _prepare_request_options(self, tools: Optional[List[Any]]) -> Optional[Any]:
        """Prepare ClaudeAgentOptions for this request with tools.
        
        Args:
            tools: Optional list of AG-UI tools
            
        Returns:
            ClaudeAgentOptions instance (with cli_path preserved) or None to reuse existing client
        """
        if ClaudeAgentOptions is None:
            return None
        
        # Even if no tools, we should return options with cli_path for stateless mode fallback
        if not tools:
            # Return existing options if available (includes cli_path)
            return self._claude_options
        
        # Convert AG-UI tools to Claude SDK format
        from .tool_adapter import ToolAdapter
        
        try:
            # Create MCP server for AG-UI tools
            mcp_server = ToolAdapter.create_mcp_server_for_tools(
                ag_ui_tools=tools,
                server_name="ag_ui_client_tools",
                server_version="1.0.0"
            )
            
            # Build options dict, starting with existing options if any
            options_dict = {}
            
            # Copy existing options attributes if available
            if self._claude_options:
                # Try to copy common options, including cli_path for CLI tool detection
                common_attrs = [
                    'system_prompt', 'permission_mode', 'cwd', 'allowed_tools',
                    'mcp_servers', 'setting_sources', 'max_tokens', 'temperature',
                    'cli_path'  # Important: preserve cli_path for stateless mode fallback
                ]
                for attr in common_attrs:
                    if hasattr(self._claude_options, attr):
                        value = getattr(self._claude_options, attr)
                        if value is not None:
                            options_dict[attr] = value
            
            # Merge MCP servers
            if 'mcp_servers' not in options_dict:
                options_dict['mcp_servers'] = {}
            elif not isinstance(options_dict['mcp_servers'], dict):
                options_dict['mcp_servers'] = {}
            
            options_dict['mcp_servers']['ag_ui_client_tools'] = mcp_server
            
            # Add tool names to allowed_tools
            tool_names = [f"mcp__ag_ui_client_tools__{tool.name}" for tool in tools]
            if 'allowed_tools' in options_dict:
                existing_tools = options_dict['allowed_tools'] or []
                options_dict['allowed_tools'] = list(set(existing_tools + tool_names))
            else:
                options_dict['allowed_tools'] = tool_names
            
            return ClaudeAgentOptions(**options_dict)
        except Exception as e:
            logger.error(f"Failed to prepare tools for request: {e}", exc_info=True)
            return self._claude_options
    
    async def _call_claude_sdk(
        self,
        claude_client: Any,
        prompt: str,
        options: Optional[Any] = None
    ) -> AsyncGenerator[Message, None]:
        """Call Claude SDK and yield Message responses.
        
        Supports both persistent sessions (ClaudeSDKClient) and stateless mode (query()).
        
        Args:
            claude_client: ClaudeSDKClient instance or None for stateless mode
            prompt: User prompt string
            options: Optional ClaudeAgentOptions for this request
            
        Yields:
            Message objects from Claude SDK
        """
        request_options = options or self._claude_options
        
        if claude_client is None:
            # Stateless mode - use query() function
            if claude_query is None:
                raise ImportError("claude-agent-sdk is not installed")
            
            async for message in claude_query(prompt=prompt, options=request_options):
                yield message
        else:
            # Persistent session mode - use ClaudeSDKClient
            # ClaudeSDKClient is an async context manager and requires connect() before query()
            # According to docs: https://docs.claude.com/zh-CN/api/agent-sdk/python
            if ClaudeSDKClient and isinstance(ClaudeSDKClient, type) and isinstance(claude_client, ClaudeSDKClient):
                # Real ClaudeSDKClient instance - ensure it's connected
                # ClaudeSDKClient supports async context manager, but we manage connection manually
                # to reuse the same client across multiple queries in the same session
                if hasattr(claude_client, 'connect'):
                    try:
                        # Check if already connected by trying to connect
                        # The connect() method will raise an error if already connected
                        await claude_client.connect()
                        logger.debug("Connected ClaudeSDKClient")
                    except Exception as e:
                        # If already connected, the error message typically contains "already connected"
                        error_msg = str(e).lower()
                        if "already connected" in error_msg or "already_connected" in error_msg:
                            logger.debug("ClaudeSDKClient already connected, reusing connection")
                        else:
                            # Re-raise if it's a different error
                            raise
            # For Mock objects or when ClaudeSDKClient is not available, just use it directly
            
            # Send query to client
            # According to docs, query() sends a prompt and returns immediately
            await claude_client.query(prompt)
            
            # Receive response stream
            # receive_response() yields messages as they arrive
            async for message in claude_client.receive_response():
                yield message
    
    def _get_claude_client(self, session_key: str, request_options: Optional[Any] = None) -> Any:
        """Get or create Claude SDK client for a session.
        
        For persistent sessions, returns a ClaudeSDKClient instance.
        For stateless mode, returns None (will use query() function directly).
        
        Args:
            session_key: Session key for lookup
            request_options: Optional options for this request (used when creating new client)
        """
        if not self._use_persistent_sessions:
            # Stateless mode - use query() function directly
            return None
        
        # Check if we have a persistent client
        existing_client = self._session_manager.get_claude_client(session_key)
        
        # If we have request-specific options with tools, consider recreating client
        # For now, reuse existing client if available and no request-specific options
        if existing_client and not request_options:
            return existing_client
        
        # Create new ClaudeSDKClient
        if ClaudeSDKClient is None:
            raise ImportError("claude-agent-sdk is not installed. Install it with: pip install claude-agent-sdk")
        
        # Use request-specific options if provided, otherwise use default
        options = request_options or self._claude_options
        
        # If we have an existing client but need new options, replace it
        if existing_client and request_options:
            logger.debug(f"Recreating ClaudeSDKClient for session {session_key} with new options")
        
        # Create client with options
        client = ClaudeSDKClient(options=options)
        self._session_manager.set_claude_client(session_key, client)
        logger.debug(f"Created new ClaudeSDKClient for session {session_key}")
        return client
    
    async def _extract_user_prompt(
        self,
        messages: List[Any],
        tool_results: Optional[List[Dict]] = None
    ) -> str:
        """Extract user prompt from AG-UI messages.
        
        Claude SDK query() and client.query() accept a prompt string.
        For multi-turn conversations with persistent sessions, we combine
        the conversation history into the prompt.
        
        Args:
            messages: List of AG-UI messages
            tool_results: Optional tool result messages
            
        Returns:
            Combined prompt string
        """
        if not messages:
            return ""
        
        # Extract text from user messages
        user_texts = []
        for message in messages:
            if hasattr(message, 'role') and message.role == "user":
                content = getattr(message, 'content', '')
                if content:
                    user_texts.append(str(content))
        
        # Add tool results if provided
        if tool_results:
            for tool_result in tool_results:
                tool_msg = tool_result['message']
                tool_content = getattr(tool_msg, 'content', '')
                if tool_content:
                    user_texts.append(f"[Tool result]: {tool_content}")
        
        # Combine into single prompt
        # For persistent sessions, Claude SDK maintains conversation history
        # So we mainly need the latest user message
        if user_texts:
            # Use the latest user message as the prompt
            return user_texts[-1]
        
        return ""
    
    async def _stream_events(
        self,
        execution: ExecutionState
    ) -> AsyncGenerator[BaseEvent, None]:
        """Stream events from execution queue."""
        while True:
            try:
                event = await asyncio.wait_for(
                    execution.event_queue.get(),
                    timeout=1.0
                )
                
                if event is None:
                    execution.is_complete = True
                    break
                
                yield event
                
            except asyncio.TimeoutError:
                if execution.is_stale(self._execution_timeout):
                    yield RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        message="Execution timed out",
                        code="EXECUTION_TIMEOUT"
                    )
                    break
                
                if execution.task.done():
                    if execution.event_queue.qsize() > 0:
                        continue
                    break
    
    async def _add_pending_tool_call(
        self,
        session_id: str,
        tool_call_id: str,
        app_name: str,
        user_id: str
    ):
        """Add a tool call to the session's pending list."""
        try:
            pending_calls = await self._session_manager.get_session_state(
                session_id, app_name, user_id
            ) or {}
            pending_calls = pending_calls.get("pending_tool_calls", [])
            
            if tool_call_id not in pending_calls:
                pending_calls.append(tool_call_id)
                await self._session_manager.update_session_state(
                    session_id,
                    app_name,
                    user_id,
                    {"pending_tool_calls": pending_calls}
                )
        except Exception as e:
            logger.error(f"Failed to add pending tool call: {e}")
    
    async def _has_pending_tool_calls(self, session_id: str) -> bool:
        """Check if session has pending tool calls."""
        try:
            metadata = self._get_session_metadata(session_id)
            if metadata:
                state = await self._session_manager.get_session_state(
                    session_id,
                    metadata["app_name"],
                    metadata["user_id"]
                )
                if state:
                    return len(state.get("pending_tool_calls", [])) > 0
        except Exception as e:
            logger.error(f"Failed to check pending tool calls: {e}")
        return False
    
    def _get_session_metadata(self, session_id: str) -> Optional[Dict[str, str]]:
        """Get session metadata."""
        if session_id in self._session_lookup_cache:
            return self._session_lookup_cache[session_id]
        return None
    
    async def _cleanup_stale_executions(self):
        """Clean up stale executions."""
        stale_threads = []
        for thread_id, execution in self._active_executions.items():
            if execution.is_stale(self._execution_timeout):
                stale_threads.append(thread_id)
        
        for thread_id in stale_threads:
            execution = self._active_executions.pop(thread_id)
            await execution.cancel()
            logger.info(f"Cleaned up stale execution for thread {thread_id}")
    
    async def close(self):
        """Clean up resources."""
        async with self._execution_lock:
            for execution in self._active_executions.values():
                await execution.cancel()
            self._active_executions.clear()
        
        self._session_lookup_cache.clear()
        await self._session_manager.stop_cleanup_task()

