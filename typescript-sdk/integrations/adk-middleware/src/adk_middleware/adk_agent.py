# src/adk_agent.py

"""Main ADKAgent implementation for bridging AG-UI Protocol with Google ADK."""

from typing import Optional, Dict, Callable, Any, AsyncGenerator, List
import time
import json
import asyncio
from datetime import datetime

from ag_ui.core import (
    RunAgentInput, BaseEvent, EventType,
    RunStartedEvent, RunFinishedEvent, RunErrorEvent,
    TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent,
    StateSnapshotEvent, StateDeltaEvent,
    Context, ToolMessage
)

from google.adk import Runner
from google.adk.agents import BaseAgent as ADKBaseAgent, RunConfig as ADKRunConfig
from google.adk.agents.run_config import StreamingMode
from google.adk.sessions import InMemorySessionService
from google.adk.artifacts import BaseArtifactService, InMemoryArtifactService
from google.adk.memory import BaseMemoryService, InMemoryMemoryService
from google.adk.auth.credential_service.base_credential_service import BaseCredentialService
from google.adk.auth.credential_service.in_memory_credential_service import InMemoryCredentialService
from google.genai import types

from .agent_registry import AgentRegistry
from .event_translator import EventTranslator
from .session_manager import SessionManager
from .execution_state import ExecutionState
from .client_proxy_toolset import ClientProxyToolset

import logging
logger = logging.getLogger(__name__)


class ADKAgent:
    """Middleware to bridge AG-UI Protocol with Google ADK agents.
    
    This agent translates between the AG-UI protocol events and Google ADK events,
    managing sessions, state, and the lifecycle of ADK agents.
    """
    
    def __init__(
        self,
        # App identification
        app_name: Optional[str] = None,
        session_timeout_seconds: Optional[int] = 1200,
        app_name_extractor: Optional[Callable[[RunAgentInput], str]] = None,
        
        # User identification
        user_id: Optional[str] = None,
        user_id_extractor: Optional[Callable[[RunAgentInput], str]] = None,
        
        # ADK Services (session service now encapsulated in session manager)
        artifact_service: Optional[BaseArtifactService] = None,
        memory_service: Optional[BaseMemoryService] = None,
        credential_service: Optional[BaseCredentialService] = None,
        
        # Configuration
        run_config_factory: Optional[Callable[[RunAgentInput], ADKRunConfig]] = None,
        use_in_memory_services: bool = True,
        
        # Tool configuration
        execution_timeout_seconds: int = 600,  # 10 minutes
        tool_timeout_seconds: int = 300,  # 5 minutes
        max_concurrent_executions: int = 10
    ):
        """Initialize the ADKAgent.
        
        Args:
            app_name: Static application name for all requests
            app_name_extractor: Function to extract app name dynamically from input
            user_id: Static user ID for all requests
            user_id_extractor: Function to extract user ID dynamically from input
            artifact_service: File/artifact storage service
            memory_service: Conversation memory and search service (also enables automatic session memory)
            credential_service: Authentication credential storage
            run_config_factory: Function to create RunConfig per request
            use_in_memory_services: Use in-memory implementations for unspecified services
            execution_timeout_seconds: Timeout for entire execution
            tool_timeout_seconds: Timeout for individual tool calls
            max_concurrent_executions: Maximum concurrent background executions
        """
        if app_name and app_name_extractor:
            raise ValueError("Cannot specify both 'app_name' and 'app_name_extractor'")
        
        # app_name, app_name_extractor, or neither (use agent name as default)
        
        if user_id and user_id_extractor:
            raise ValueError("Cannot specify both 'user_id' and 'user_id_extractor'")
        
        self._static_app_name = app_name
        self._app_name_extractor = app_name_extractor
        self._static_user_id = user_id
        self._user_id_extractor = user_id_extractor
        self._run_config_factory = run_config_factory or self._default_run_config
        
        # Initialize services with intelligent defaults
        if use_in_memory_services:
            self._artifact_service = artifact_service or InMemoryArtifactService()
            self._memory_service = memory_service or InMemoryMemoryService()
            self._credential_service = credential_service or InMemoryCredentialService()
        else:
            # Require explicit services for production
            self._artifact_service = artifact_service
            self._memory_service = memory_service
            self._credential_service = credential_service
        
        # Runner cache: key is "{agent_id}:{user_id}"
        self._runners: Dict[str, Runner] = {}
        
        # Session lifecycle management - use singleton
        # Initialize with session service based on use_in_memory_services
        if use_in_memory_services:
            session_service = InMemorySessionService()
        else:
            # For production, you would inject the real session service here
            session_service = InMemorySessionService()  # TODO: Make this configurable
            
        self._session_manager = SessionManager.get_instance(
            session_service=session_service,
            memory_service=memory_service,  # Pass memory service for automatic session memory
            session_timeout_seconds=session_timeout_seconds,  # 20 minutes default
            cleanup_interval_seconds=300,  # 5 minutes default
            max_sessions_per_user=None,    # No limit by default
            auto_cleanup=True              # Enable by default
        )
        
        # Tool execution tracking
        self._active_executions: Dict[str, ExecutionState] = {}
        self._execution_timeout = execution_timeout_seconds
        self._tool_timeout = tool_timeout_seconds
        self._max_concurrent = max_concurrent_executions
        self._execution_lock = asyncio.Lock()
        
        # Event translator will be created per-session for thread safety
        
        # Cleanup is managed by the session manager
        # Will start when first async operation runs
    
    def _get_app_name(self, input: RunAgentInput) -> str:
        """Resolve app name with clear precedence."""
        if self._static_app_name:
            return self._static_app_name
        elif self._app_name_extractor:
            return self._app_name_extractor(input)
        else:
            return self._default_app_extractor(input)
    
    def _default_app_extractor(self, input: RunAgentInput) -> str:
        """Default app extraction logic - use agent name from registry."""
        # Get the agent from registry and use its name as app name
        try:
            agent_id = self._get_agent_id()
            registry = AgentRegistry.get_instance()
            adk_agent = registry.get_agent(agent_id)
            return adk_agent.name
        except Exception as e:
            logger.warning(f"Could not get agent name for app_name, using default: {e}")
            return "AG-UI ADK Agent"
    
    def _get_user_id(self, input: RunAgentInput) -> str:
        """Resolve user ID with clear precedence."""
        if self._static_user_id:
            return self._static_user_id
        elif self._user_id_extractor:
            return self._user_id_extractor(input)
        else:
            return self._default_user_extractor(input)
    
    def _default_user_extractor(self, input: RunAgentInput) -> str:
        """Default user extraction logic."""
        # Use thread_id as default (assumes thread per user)
        return f"thread_user_{input.thread_id}"
    
    def _default_run_config(self, input: RunAgentInput) -> ADKRunConfig:
        """Create default RunConfig with SSE streaming enabled."""
        return ADKRunConfig(
            streaming_mode=StreamingMode.SSE,
            save_input_blobs_as_artifacts=True
        )
    
    def _get_agent_id(self) -> str:
        """Get the agent ID - always uses default agent from registry."""
        return "default"
    
    def _get_or_create_runner(self, agent_id: str, adk_agent: ADKBaseAgent, user_id: str, app_name: str) -> Runner:
        """Get existing runner or create a new one."""
        runner_key = f"{agent_id}:{user_id}"
        
        if runner_key not in self._runners:
            self._runners[runner_key] = Runner(
                app_name=app_name,  # Use the resolved app_name
                agent=adk_agent,
                session_service=self._session_manager._session_service,
                artifact_service=self._artifact_service,
                memory_service=self._memory_service,
                credential_service=self._credential_service
            )
        
        return self._runners[runner_key]
    
    async def run(self, input: RunAgentInput, agent_id = None) -> AsyncGenerator[BaseEvent, None]:
        """Run the ADK agent with tool support.
        
        Enhanced to handle both new requests and tool result submissions.
        
        Args:
            input: The AG-UI run input
            
        Yields:
            AG-UI protocol events
        """
        thread_id = input.thread_id
        
        # Enhanced debug logging for run entry
        print(f"🔍 RUN ENTRY: thread_id={thread_id}, run_id={input.run_id}")
        print(f"🔍 RUN ENTRY: {len(input.messages)} messages in input")
        print(f"🔍 RUN ENTRY: Tools provided: {len(input.tools) if input.tools else 0}")
        
        # Check if this is a tool result submission
        if self._is_tool_result_submission(input):
            print(f"🔍 RUN ENTRY: Detected as tool result submission")
            
            # Send RUN_STARTED event (required by AG-UI protocol)
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input.thread_id,
                run_id=input.run_id
            )
            
            # Handle tool results for existing execution
            async for event in self._handle_tool_result_submission(input):
                yield event
        else:
            print(f"🔍 RUN ENTRY: Detected as new execution")
            # Start new execution
            async for event in self._start_new_execution(input,agent_id):
                yield event
    
    async def _ensure_session_exists(self, app_name: str, user_id: str, session_id: str, initial_state: dict):
        """Ensure a session exists, creating it if necessary via session manager."""
        try:
            # Use session manager to get or create session
            adk_session = await self._session_manager.get_or_create_session(
                session_id=session_id,
                app_name=app_name,  # Use app_name for session management
                user_id=user_id,
                initial_state=initial_state
            )
            logger.debug(f"Session ready: {session_id} for user: {user_id}")
            return adk_session
        except Exception as e:
            logger.error(f"Failed to ensure session {session_id}: {e}")
            raise

    async def _convert_latest_message(self, input: RunAgentInput) -> Optional[types.Content]:
        """Convert the latest AG-UI message to ADK Content format.
        
        Handles both regular user messages and tool result messages for long-running tools.
        """
        if not input.messages:
            return None
        
        # Get the latest message
        latest_message = input.messages[-1]
        
        # Debug output that will definitely show
        print(f"🔍 CONVERT DEBUG: Converting latest message - role: {getattr(latest_message, 'role', 'NO_ROLE')}")
        print(f"🔍 CONVERT DEBUG: Message type: {type(latest_message)}")
        print(f"🔍 CONVERT DEBUG: Total messages: {len(input.messages)}")
        print(f"🔍 CONVERT DEBUG: Thread ID: {input.thread_id}")
        if hasattr(latest_message, 'content'):
            print(f"🔍 CONVERT DEBUG: Content: {repr(latest_message.content)}")
        if hasattr(latest_message, 'tool_call_id'):
            print(f"🔍 CONVERT DEBUG: Tool call ID: {latest_message.tool_call_id}")
        
        # Debug: Show ALL messages in the input
        print(f"🔍 ALL MESSAGES DEBUG: Showing all {len(input.messages)} messages:")
        for i, msg in enumerate(input.messages):
            msg_role = getattr(msg, 'role', 'NO_ROLE')
            msg_type = type(msg).__name__
            msg_content = getattr(msg, 'content', 'NO_CONTENT')
            msg_content_preview = repr(msg_content)[:100] if msg_content else 'None'
            print(f"🔍   Message {i}: {msg_type} - role={msg_role}, content={msg_content_preview}")
            if hasattr(msg, 'tool_call_id'):
                print(f"🔍   Message {i}: tool_call_id={msg.tool_call_id}")
        
        # Handle tool messages (for long-running tool results)
        if hasattr(latest_message, 'role') and latest_message.role == "tool":
            # Debug logging
            logger.debug(f"Processing tool message: {latest_message}")
            logger.debug(f"Tool message content: {repr(latest_message.content)}")
            logger.debug(f"Tool message type: {type(latest_message)}")
            
            # Convert ToolMessage to FunctionResponse content
            if latest_message.content is None or latest_message.content == "":
                # Handle empty/null content
                content = None
            elif isinstance(latest_message.content, str):
                # Try to parse JSON content
                try:
                    content = json.loads(latest_message.content)
                except json.JSONDecodeError:
                    # If JSON parsing fails, use the string as-is
                    content = latest_message.content
            else:
                # Content is already parsed (dict, etc.)
                content = latest_message.content
            
            # Get the resolved tool name if available
            tool_name = latest_message.tool_call_id  # fallback to tool_call_id
            if hasattr(input, '_resolved_tool_name') and input._resolved_tool_name:
                tool_name = input._resolved_tool_name
            
            return types.Content(
                role="user",  # Tool results are sent as user messages to ADK
                parts=[types.Part(
                    function_response=types.FunctionResponse(
                        id=latest_message.tool_call_id,
                        name=tool_name,  # Use resolved tool name
                        response=content
                    )
                )]
            )
        
        # Handle regular user messages
        elif hasattr(latest_message, 'role') and latest_message.role == "user" and latest_message.content:
            return types.Content(
                role="user",
                parts=[types.Part(text=latest_message.content)]
            )
        
        return None
    
    
    def _is_tool_result_submission(self, input: RunAgentInput) -> bool:
        """Check if this request contains tool results.
        
        Args:
            input: The run input
            
        Returns:
            True if the last message is a tool result
        """
        if not input.messages:
            print(f"🔍 TOOL_RESULT_CHECK: No messages in input")
            return False
        
        last_message = input.messages[-1]
        is_tool_result = hasattr(last_message, 'role') and last_message.role == "tool"
        print(f"🔍 TOOL_RESULT_CHECK: Last message role: {getattr(last_message, 'role', 'NO_ROLE')}")
        print(f"🔍 TOOL_RESULT_CHECK: Is tool result submission: {is_tool_result}")
        return is_tool_result
    
    async def _handle_tool_result_submission(
        self, 
        input: RunAgentInput
    ) -> AsyncGenerator[BaseEvent, None]:
        """Handle tool result submission for blocking or long-running tools.
        
        For blocking tools (future exists): Resolve the future and continue execution
        For long-running tools (no future): Start a new run with FunctionResponse
        
        Args:
            input: The run input containing tool results
            
        Yields:
            AG-UI events from continued or new execution
        """
        thread_id = input.thread_id
        
        # Extract tool results
        tool_results = self._extract_tool_results(input)
        if not tool_results:
            logger.error("No tool results found in input")
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message="No tool results found",
                code="NO_TOOL_RESULTS"
            )
            return
        
        # Check if we have an active execution with pending futures
        execution = None
        async with self._execution_lock:
            execution = self._active_executions.get(thread_id)
            
        # Separate tool results into blocking (have futures) and long-running (no futures)
        blocking_results = []
        long_running_results = []
        
        for tool_msg in tool_results:
            tool_call_id = tool_msg.tool_call_id
            
            # Check if this tool has a pending future
            if execution and tool_call_id in execution.tool_futures:
                blocking_results.append(tool_msg)
            elif execution and execution.tool_futures:
                # We have an active execution with pending tools, but this tool_call_id is not found
                # This should be treated as an error, not a long-running result
                logger.warning(f"No pending tool found for ID {tool_call_id}")
                long_running_results.append(tool_msg)  # Still add to long_running for processing
            else:
                long_running_results.append(tool_msg)
        
        logger.debug(f"TOOL DEBUG: {len(blocking_results)} blocking results, {len(long_running_results)} long-running results")
        
        # Handle blocking tool results (resolve futures)
        if blocking_results and execution:
            try:
                for tool_msg in blocking_results:
                    tool_call_id = tool_msg.tool_call_id
                    
                    # Handle tool result content properly
                    if tool_msg.content is None or tool_msg.content == "":
                        # Handle empty/null content
                        result = None
                    elif isinstance(tool_msg.content, str):
                        # Try to parse JSON content
                        try:
                            result = json.loads(tool_msg.content)
                        except json.JSONDecodeError as json_error:
                            logger.error(f"Invalid JSON in tool result for {tool_call_id}: {json_error}")
                            yield RunErrorEvent(
                                type=EventType.RUN_ERROR,
                                message=f"Invalid JSON in tool result: {str(json_error)}",
                                code="TOOL_RESULT_ERROR"
                            )
                            return
                    else:
                        # Content is already parsed (dict, etc.)
                        result = tool_msg.content
                    
                    logger.debug(f"TOOL DEBUG: Resolving blocking tool result for {tool_call_id}")
                    if not execution.resolve_tool_result(tool_call_id, result):
                        logger.warning(f"TOOL DEBUG: Failed to resolve tool future for {tool_call_id}")
                    else:
                        logger.debug(f"TOOL DEBUG: Successfully resolved tool result for {tool_call_id}")
                
                # Continue streaming events from the existing execution
                if not long_running_results:  # Only stream if we don't have long-running results to process
                    async for event in self._stream_events(execution, input.run_id):
                        yield event
                        
            except Exception as e:
                logger.error(f"Error handling blocking tool results: {e}", exc_info=True)
                yield RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message=str(e),
                    code="BLOCKING_TOOL_ERROR"
                )
                return
        
        # Handle long-running tool results (start new run)
        if long_running_results:
            # Check if we have no active execution - this means all tool results are orphaned
            if not execution:
                logger.error(f"No active execution found for thread {thread_id} with tool results")
                yield RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message="No active execution found for tool results",
                    code="NO_ACTIVE_EXECUTION"
                )
                return
            
            try:
                # Look up and resolve tool name for the long-running tool
                resolved_tool_name = None
                if execution and execution.tool_names:
                    # Assume single tool result (typical case)
                    tool_call_id = long_running_results[0].tool_call_id
                    resolved_tool_name = execution.tool_names.get(tool_call_id)
                    logger.debug(f"Resolved tool name for {tool_call_id}: {resolved_tool_name}")
                    
                    # Remove the tool name since we're processing it now
                    execution.tool_names.pop(tool_call_id, None)
                
                # Store the resolved tool name on the input for _convert_latest_message
                input._resolved_tool_name = resolved_tool_name
                
                # Start a new execution - _convert_latest_message will handle the ToolMessage conversion
                logger.info(f"Starting new run for long-running tool results on thread {thread_id}")
                async for event in self._start_new_execution(input):
                    yield event
                    
            except Exception as e:
                logger.error(f"Error handling long-running tool results: {e}", exc_info=True)
                yield RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message=str(e),
                    code="LONG_RUNNING_TOOL_ERROR"
                )
    
    def _extract_tool_results(self, input: RunAgentInput) -> List[ToolMessage]:
        """Extract tool messages from input.
        
        Args:
            input: The run input
            
        Returns:
            List of tool messages
        """
        tool_messages = []
        for message in input.messages:
            if hasattr(message, 'role') and message.role == "tool":
                tool_messages.append(message)
        return tool_messages
    
    async def _stream_events(
        self, 
        execution: ExecutionState,
        run_id: Optional[str] = None
    ) -> AsyncGenerator[BaseEvent, None]:
        """Stream events from execution queue.
        
        Enhanced to detect tool events and emit RUN_FINISHED immediately after TOOL_CALL_END
        to satisfy AG-UI protocol requirements.
        
        Args:
            execution: The execution state
            run_id: The run ID for the current request (optional)
            
        Yields:
            AG-UI events from the queue
        """
        tool_call_active = False
        
        while True:
            try:
                # Wait for event with timeout
                event = await asyncio.wait_for(
                    execution.event_queue.get(),
                    timeout=1.0  # Check every second
                )
                
                if event is None:
                    # Execution complete - emit final RUN_FINISHED
                    logger.debug(f"EXEC DEBUG: Marking execution complete for thread {execution.thread_id}")
                    execution.is_complete = True
                    
                    # Send final RUN_FINISHED event
                    yield RunFinishedEvent(
                        type=EventType.RUN_FINISHED,
                        thread_id=execution.thread_id,
                        run_id=run_id or execution.thread_id  # Use run_id if provided, otherwise thread_id
                    )
                    break
                
                # Track tool call events
                if event.type == EventType.TOOL_CALL_START:
                    tool_call_active = True
                    logger.debug(f"Tool call started: {event.tool_call_id}")
                
                yield event
                
                # Check if we just emitted TOOL_CALL_END
                if event.type == EventType.TOOL_CALL_END:
                    tool_call_active = False
                    logger.debug(f"Tool call ended: {event.tool_call_id}")
                    
                    # Always stop streaming after tool events to send RUN_FINISHED
                    # This satisfies the AG-UI protocol requirement
                    logger.info("Tool call completed - stopping event stream to send RUN_FINISHED")
                    execution.is_streaming_paused = True
                    break
                
            except asyncio.TimeoutError:
                # Check if execution is stale
                if execution.is_stale(self._execution_timeout):
                    logger.error(f"Execution timed out for thread {execution.thread_id}")
                    yield RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        message="Execution timed out",
                        code="EXECUTION_TIMEOUT"
                    )
                    break
                
                # Check if task is done
                if execution.task.done():
                    # Task completed but didn't send None
                    execution.is_complete = True
                    break
    
    async def _start_new_execution(
        self, 
        input: RunAgentInput,
        agent_id = None
    ) -> AsyncGenerator[BaseEvent, None]:
        """Start a new ADK execution with tool support.
        
        Args:
            input: The run input
            
        Yields:
            AG-UI events from the execution
        """
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
                    # Clean up stale executions
                    await self._cleanup_stale_executions()
                    
                    if len(self._active_executions) >= self._max_concurrent:
                        raise RuntimeError(
                            f"Maximum concurrent executions ({self._max_concurrent}) reached"
                        )
            
            # Start background execution
            execution = await self._start_background_execution(input,agent_id)
            
            # Store execution
            async with self._execution_lock:
                self._active_executions[input.thread_id] = execution
            
            # Stream events
            async for event in self._stream_events(execution, input.run_id):
                yield event
            
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
            # Clean up execution if complete
            async with self._execution_lock:
                if input.thread_id in self._active_executions:
                    execution = self._active_executions[input.thread_id]
                    logger.debug(f"EXEC DEBUG: Cleanup check for thread {input.thread_id}")
                    logger.debug(f"EXEC DEBUG: execution.is_complete = {execution.is_complete}")
                    logger.debug(f"EXEC DEBUG: execution.has_pending_tools() = {execution.has_pending_tools()}")
                    logger.debug(f"EXEC DEBUG: pending tool futures: {list(execution.tool_futures.keys())}")
                    
                    if execution.is_complete and not execution.has_pending_tools():
                        logger.debug(f"EXEC DEBUG: Removing execution for thread {input.thread_id} - complete and no pending tools")
                        del self._active_executions[input.thread_id]
                    else:
                        logger.debug(f"EXEC DEBUG: Keeping execution for thread {input.thread_id} - {'incomplete' if not execution.is_complete else 'has pending tools'}")
                else:
                    logger.debug(f"EXEC DEBUG: Thread {input.thread_id} not in active executions")
    
    async def _start_background_execution(
        self, 
        input: RunAgentInput,
        agent_id = None
    ) -> ExecutionState:
        """Start ADK execution in background with tool support.
        
        Args:
            input: The run input
            
        Returns:
            ExecutionState tracking the background execution
        """
        event_queue = asyncio.Queue()
        tool_futures = {}
        # Extract necessary information
        agent_id = agent_id or self._get_agent_id()
        user_id = self._get_user_id(input)
        app_name = self._get_app_name(input)
        
        logger.debug(f"DEBUG: Starting background execution with agent_id: {agent_id}")
        
        # Get the ADK agent
        registry = AgentRegistry.get_instance()
        
        logger.debug(f"DEBUG: Available agents in registry: {registry.list_registered_agents()}")
        logger.debug(f"DEBUG: Has default agent: {registry._default_agent is not None}")
        
        try:
            adk_agent = registry.get_agent(agent_id)
            logger.debug(f"DEBUG: Successfully retrieved agent: {adk_agent}")
        except Exception as e:
            logger.error(f"DEBUG: Failed to get agent '{agent_id}': {e}")
            raise
        
        # Create execution state first to get tool_names reference
        execution_state = ExecutionState(
            task=None,  # Will be set after creating the task
            thread_id=input.thread_id,
            event_queue=event_queue,
            tool_futures=tool_futures
        )
        
        # Create dynamic toolset if tools provided
        toolset = None
        if input.tools:
            toolset = ClientProxyToolset(
                ag_ui_tools=input.tools,
                event_queue=event_queue,
                tool_futures=tool_futures,
                tool_timeout_seconds=self._tool_timeout,
                tool_names=execution_state.tool_names
            )
        
        # Create background task
        task = asyncio.create_task(
            self._run_adk_in_background(
                input=input,
                adk_agent=adk_agent,
                user_id=user_id,
                app_name=app_name,
                toolset=toolset,
                event_queue=event_queue
            )
        )
        
        # Set the task on the execution state
        execution_state.task = task
        
        return execution_state
    
    async def _run_adk_in_background(
        self,
        input: RunAgentInput,
        adk_agent: ADKBaseAgent,
        user_id: str,
        app_name: str,
        toolset: Optional[ClientProxyToolset],
        event_queue: asyncio.Queue
    ):
        """Run ADK agent in background, emitting events to queue.
        
        Args:
            input: The run input
            adk_agent: The ADK agent to run
            user_id: User ID
            app_name: App name
            toolset: Optional client proxy toolset
            event_queue: Queue for emitting events
        """
        try:
            # Handle tool combination if toolset provided
            if toolset:
                # Get existing tools from the agent
                existing_tools = []
                if hasattr(adk_agent, 'tools') and adk_agent.tools:
                    existing_tools = list(adk_agent.tools) if isinstance(adk_agent.tools, (list, tuple)) else [adk_agent.tools]
                
                # Combine existing tools with our proxy toolset
                combined_tools = existing_tools + [toolset]
                adk_agent.tools = combined_tools
                
                logger.debug(f"Combined {len(existing_tools)} existing tools with proxy toolset")
            
            # Get or create runner
            runner = self._get_or_create_runner(
                agent_id="default", 
                adk_agent=adk_agent,
                user_id=user_id,
                app_name=app_name
            )
            
            # Create RunConfig
            run_config = self._run_config_factory(input)
            
            # Ensure session exists
            await self._ensure_session_exists(
                app_name, user_id, input.thread_id, input.state
            )
            
            # Convert messages
            new_message = await self._convert_latest_message(input)
            
            # Create event translator
            event_translator = EventTranslator()
            
            # Debug: Check session events before running ADK
            try:
                # Get session using the session manager's method
                adk_session = await self._session_manager.get_or_create_session(
                    session_id=input.thread_id,
                    app_name=app_name,
                    user_id=user_id,
                    initial_state={}
                )
                if adk_session and hasattr(adk_session, 'events'):
                    logger.debug(f"SESSION DEBUG: Found {len(adk_session.events)} events in session {input.thread_id}")
                    for i, event in enumerate(adk_session.events[-5:]):  # Show last 5 events
                        logger.debug(f"SESSION DEBUG: Event {i}: author={event.author}, content_parts={len(event.content.parts) if event.content else 0}")
                        if event.content and event.content.parts:
                            for j, part in enumerate(event.content.parts):
                                if hasattr(part, 'function_call') and part.function_call:
                                    logger.debug(f"SESSION DEBUG:   Part {j}: FunctionCall(id={part.function_call.id}, name={part.function_call.name})")
                                elif hasattr(part, 'function_response') and part.function_response:
                                    logger.debug(f"SESSION DEBUG:   Part {j}: FunctionResponse(id={part.function_response.id}, name={part.function_response.name})")
                                elif hasattr(part, 'text') and part.text:
                                    logger.debug(f"SESSION DEBUG:   Part {j}: Text('{part.text[:50]}...')")
            except Exception as e:
                logger.debug(f"SESSION DEBUG: Failed to get session: {e}")
            
            # Run ADK agent
            async for adk_event in runner.run_async(
                user_id=user_id,
                session_id=input.thread_id,
                new_message=new_message,
                run_config=run_config
            ):

                # Translate and emit events
                async for ag_ui_event in event_translator.translate(
                    adk_event,
                    input.thread_id,
                    input.run_id
                ):
                    
                    await event_queue.put(ag_ui_event)

            # Force close any streaming messages
            async for ag_ui_event in event_translator.force_close_streaming_message():
                await event_queue.put(ag_ui_event)
            
            # Signal completion
            logger.debug(f"EXEC DEBUG: Background execution completing for thread {input.thread_id}")
            await event_queue.put(None)
            
        except Exception as e:
            logger.error(f"Background execution error: {e}", exc_info=True)
            # Put error in queue
            await event_queue.put(
                RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message=str(e),
                    code="BACKGROUND_EXECUTION_ERROR"
                )
            )
            await event_queue.put(None)
        finally:
            # Clean up toolset
            if toolset:
                await toolset.close()
    
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
        """Clean up resources including active executions."""
        # Cancel all active executions
        async with self._execution_lock:
            for execution in self._active_executions.values():
                await execution.cancel()
            self._active_executions.clear()
        
        # Stop session manager cleanup task
        await self._session_manager.stop_cleanup_task()
        
        # Close all runners
        for runner in self._runners.values():
            await runner.close()
        
        self._runners.clear()