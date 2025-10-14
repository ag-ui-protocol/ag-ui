# src/adk_agent.py

"""Main ADKAgent implementation for bridging AG-UI Protocol with Google ADK."""

from typing import Optional, Dict, Callable, Any, AsyncGenerator, List
import time
import json
import asyncio
import inspect
from datetime import datetime

from ag_ui.core import (
    RunAgentInput, BaseEvent, EventType,
    RunStartedEvent, RunFinishedEvent, RunErrorEvent,
    ToolCallEndEvent, SystemMessage,ToolCallResultEvent
)

from google.adk import Runner
from google.adk.agents import BaseAgent, RunConfig as ADKRunConfig
from google.adk.agents.run_config import StreamingMode
from google.adk.sessions import BaseSessionService, InMemorySessionService
from google.adk.artifacts import BaseArtifactService, InMemoryArtifactService
from google.adk.memory import BaseMemoryService, InMemoryMemoryService
from google.adk.auth.credential_service.base_credential_service import BaseCredentialService
from google.adk.auth.credential_service.in_memory_credential_service import InMemoryCredentialService
from google.genai import types

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
        # ADK Agent instance
        adk_agent: BaseAgent,
        
        # App identification
        app_name: Optional[str] = None,
        session_timeout_seconds: Optional[int] = 1200,
        app_name_extractor: Optional[Callable[[RunAgentInput], str]] = None,
        
        # User identification
        user_id: Optional[str] = None,
        user_id_extractor: Optional[Callable[[RunAgentInput], str]] = None,
        
        # ADK Services
        session_service: Optional[BaseSessionService] = None,
        artifact_service: Optional[BaseArtifactService] = None,
        memory_service: Optional[BaseMemoryService] = None,
        credential_service: Optional[BaseCredentialService] = None,
        
        # Configuration
        run_config_factory: Optional[Callable[[RunAgentInput], ADKRunConfig]] = None,
        use_in_memory_services: bool = True,
        
        # Tool configuration
        execution_timeout_seconds: int = 600,  # 10 minutes
        tool_timeout_seconds: int = 300,  # 5 minutes
        max_concurrent_executions: int = 10,
        
        # Session cleanup configuration
        cleanup_interval_seconds: int = 300  # 5 minutes default
    ):
        """Initialize the ADKAgent.
        
        Args:
            adk_agent: The ADK agent instance to use
            app_name: Static application name for all requests
            app_name_extractor: Function to extract app name dynamically from input
            user_id: Static user ID for all requests
            user_id_extractor: Function to extract user ID dynamically from input
            session_service: Session management service (defaults to InMemorySessionService)
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
        
        self._adk_agent = adk_agent
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
        
        
        # Session lifecycle management - use singleton
        # Use provided session service or create default based on use_in_memory_services
        if session_service is None:
            session_service = InMemorySessionService()  # Default for both dev and production
            
        self._session_manager = SessionManager.get_instance(
            session_service=session_service,
            memory_service=self._memory_service,  # Pass memory service for automatic session memory
            session_timeout_seconds=session_timeout_seconds,  # 20 minutes default
            cleanup_interval_seconds=cleanup_interval_seconds,
            max_sessions_per_user=None,    # No limit by default
            auto_cleanup=True              # Enable by default
        )
        
        # Tool execution tracking
        self._active_executions: Dict[str, ExecutionState] = {}
        self._execution_timeout = execution_timeout_seconds
        self._tool_timeout = tool_timeout_seconds
        self._max_concurrent = max_concurrent_executions
        self._execution_lock = asyncio.Lock()

        # Session lookup cache for efficient session ID to metadata mapping
        # Maps session_id -> {"app_name": str, "user_id": str}
        self._session_lookup_cache: Dict[str, Dict[str, str]] = {}
        
        # Event translator will be created per-session for thread safety
        
        # Cleanup is managed by the session manager
        # Will start when first async operation runs

    def _get_session_metadata(self, session_id: str) -> Optional[Dict[str, str]]:
        """Get session metadata (app_name, user_id) for a session ID efficiently.

        Args:
            session_id: The session ID to lookup

        Returns:
            Dictionary with app_name and user_id, or None if not found
        """
        # Try cache first for O(1) lookup
        if session_id in self._session_lookup_cache:
            return self._session_lookup_cache[session_id]

        # Fallback to linear search if not in cache (for existing sessions)
        # This maintains backward compatibility
        try:
            for uid, keys in self._session_manager._user_sessions.items():
                for key in keys:
                    if key.endswith(f":{session_id}"):
                        app_name = key.split(':', 1)[0]
                        metadata = {"app_name": app_name, "user_id": uid}
                        # Cache for future lookups
                        self._session_lookup_cache[session_id] = metadata
                        return metadata
        except Exception as e:
            logger.error(f"Error during session metadata lookup for {session_id}: {e}")

        return None
    
    def _get_app_name(self, input: RunAgentInput) -> str:
        """Resolve app name with clear precedence."""
        if self._static_app_name:
            return self._static_app_name
        elif self._app_name_extractor:
            return self._app_name_extractor(input)
        else:
            return self._default_app_extractor(input)
    
    def _default_app_extractor(self, input: RunAgentInput) -> str:
        """Default app extraction logic - use agent name directly."""
        # Use the ADK agent's name as app name
        try:
            return self._adk_agent.name
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
    
    async def _add_pending_tool_call_with_context(self, session_id: str, tool_call_id: str, app_name: str, user_id: str):
        """Add a tool call to the session's pending list for HITL tracking.
        
        Args:
            session_id: The session ID (thread_id)
            tool_call_id: The tool call ID to track
            app_name: App name (for session lookup)
            user_id: User ID (for session lookup)
        """
        logger.debug(f"Adding pending tool call {tool_call_id} for session {session_id}, app_name={app_name}, user_id={user_id}")
        try:
            # Get current pending calls using SessionManager
            pending_calls = await self._session_manager.get_state_value(
                session_id=session_id,
                app_name=app_name,
                user_id=user_id,
                key="pending_tool_calls",
                default=[]
            )
            
            # Add new tool call if not already present
            if tool_call_id not in pending_calls:
                pending_calls.append(tool_call_id)
                
                # Update the state using SessionManager
                success = await self._session_manager.set_state_value(
                    session_id=session_id,
                    app_name=app_name,
                    user_id=user_id,
                    key="pending_tool_calls",
                    value=pending_calls
                )
                
                if success:
                    logger.info(f"Added tool call {tool_call_id} to session {session_id} pending list")
        except Exception as e:
            logger.error(f"Failed to add pending tool call {tool_call_id} to session {session_id}: {e}")
    
    async def _remove_pending_tool_call(self, session_id: str, tool_call_id: str):
        """Remove a tool call from the session's pending list.

        Uses efficient session lookup to find the session without needing explicit app_name/user_id.

        Args:
            session_id: The session ID (thread_id)
            tool_call_id: The tool call ID to remove
        """
        try:
            # Use efficient session metadata lookup
            metadata = self._get_session_metadata(session_id)

            if metadata:
                app_name = metadata["app_name"]
                user_id = metadata["user_id"]

                # Get current pending calls using SessionManager
                pending_calls = await self._session_manager.get_state_value(
                    session_id=session_id,
                    app_name=app_name,
                    user_id=user_id,
                    key="pending_tool_calls",
                    default=[]
                )

                # Remove tool call if present
                if tool_call_id in pending_calls:
                    pending_calls.remove(tool_call_id)

                    # Update the state using SessionManager
                    success = await self._session_manager.set_state_value(
                        session_id=session_id,
                        app_name=app_name,
                        user_id=user_id,
                        key="pending_tool_calls",
                        value=pending_calls
                    )
                    
                    if success:
                        logger.info(f"Removed tool call {tool_call_id} from session {session_id} pending list")
        except Exception as e:
            logger.error(f"Failed to remove pending tool call {tool_call_id} from session {session_id}: {e}")
    
    async def _has_pending_tool_calls(self, session_id: str) -> bool:
        """Check if session has pending tool calls (HITL scenario).

        Args:
            session_id: The session ID (thread_id)

        Returns:
            True if session has pending tool calls
        """
        try:
            # Use efficient session metadata lookup
            metadata = self._get_session_metadata(session_id)

            if metadata:
                app_name = metadata["app_name"]
                user_id = metadata["user_id"]

                # Get pending calls using SessionManager
                pending_calls = await self._session_manager.get_state_value(
                    session_id=session_id,
                    app_name=app_name,
                    user_id=user_id,
                    key="pending_tool_calls",
                    default=[]
                )
                return len(pending_calls) > 0
        except Exception as e:
            logger.error(f"Failed to check pending tool calls for session {session_id}: {e}")

        return False
    
    
    def _default_run_config(self, input: RunAgentInput) -> ADKRunConfig:
        """Create default RunConfig with SSE streaming enabled."""
        return ADKRunConfig(
            streaming_mode=StreamingMode.SSE,
            save_input_blobs_as_artifacts=True
        )
    
    
    def _create_runner(self, adk_agent: BaseAgent, user_id: str, app_name: str) -> Runner:
        """Create a new runner instance."""
        return Runner(
            app_name=app_name,
            agent=adk_agent,
            session_service=self._session_manager._session_service,
            artifact_service=self._artifact_service,
            memory_service=self._memory_service,
            credential_service=self._credential_service
        )
    
    async def run(self, input: RunAgentInput) -> AsyncGenerator[BaseEvent, None]:
        """Run the ADK agent with client-side tool support.
        
        All client-side tools are long-running. For tool result submissions,
        we continue existing executions. For new requests, we start new executions.
        ADK sessions handle conversation continuity and tool result processing.
        
        Args:
            input: The AG-UI run input
            
        Yields:
            AG-UI protocol events
        """
        # Check if this is a tool result submission for an existing execution
        if self._is_tool_result_submission(input):
            # Handle tool results for existing execution
            async for event in self._handle_tool_result_submission(input):
                yield event
        else:
            # Start new execution for regular requests
            async for event in self._start_new_execution(input):
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

            # Update session lookup cache for efficient session ID to metadata mapping
            self._session_lookup_cache[session_id] = {
                "app_name": app_name,
                "user_id": user_id
            }

            logger.debug(f"Session ready: {session_id} for user: {user_id}")
            return adk_session
        except Exception as e:
            logger.error(f"Failed to ensure session {session_id}: {e}")
            raise

    async def _convert_latest_message(self, input: RunAgentInput) -> Optional[types.Content]:
        """Convert the latest user message to ADK Content format."""
        if not input.messages:
            return None
        
        # Get the latest user message
        for message in reversed(input.messages):
            if message.role == "user" and message.content:
                return types.Content(
                    role="user",
                    parts=[types.Part(text=message.content)]
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
            return False
        
        last_message = input.messages[-1]
        return hasattr(last_message, 'role') and last_message.role == "tool"
    
    async def _handle_tool_result_submission(
        self, 
        input: RunAgentInput
    ) -> AsyncGenerator[BaseEvent, None]:
        """Handle tool result submission for existing execution.
        
        Args:
            input: The run input containing tool results
            
        Yields:
            AG-UI events from continued execution
        """
        thread_id = input.thread_id
        
        # Extract tool results that is send by the frontend 
        tool_results = await self._extract_tool_results(input)
        
        # if the tool results are not sent by the fronted then call the tool function
        if not tool_results:
            logger.error(f"Tool result submission without tool results for thread {thread_id}")
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message="No tool results found in submission",
                code="NO_TOOL_RESULTS"
            )
            return
        
        try:
            # Check if tool result matches any pending tool calls for better debugging
            for tool_result in tool_results:
                tool_call_id = tool_result['message'].tool_call_id
                has_pending = await self._has_pending_tool_calls(thread_id)
                
                if has_pending:
                    # Could add more specific check here for the exact tool_call_id
                    # but for now just log that we're processing a tool result while tools are pending
                    logger.debug(f"Processing tool result {tool_call_id} for thread {thread_id} with pending tools")
                    # Remove from pending tool calls now that we're processing it
                    await self._remove_pending_tool_call(thread_id, tool_call_id)
                else:
                    # No pending tools - this could be a stale result or from a different session
                    logger.warning(f"No pending tool calls found for tool result {tool_call_id} in thread {thread_id}")
            
            # Since all tools are long-running, all tool results are standalone
            # and should start new executions with the tool results
            logger.info(f"Starting new execution for tool result in thread {thread_id}")
            async for event in self._start_new_execution(input):
                yield event
                
        except Exception as e:
            logger.error(f"Error handling tool results: {e}", exc_info=True)
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=f"Failed to process tool results: {str(e)}",
                code="TOOL_RESULT_PROCESSING_ERROR"
            )
    
    async def _extract_tool_results(self, input: RunAgentInput) -> List[Dict]:
        """Extract tool messages with their names from input.
        
        Only extracts the most recent tool message to avoid accumulation issues
        where multiple tool results are sent to the LLM causing API errors.
        
        Args:
            input: The run input
            
        Returns:
            List of dicts containing tool name and message (single item for most recent)
        """
        # Create a mapping of tool_call_id to tool name
        tool_call_map = {}
        for message in input.messages:
            if hasattr(message, 'tool_calls') and message.tool_calls:
                for tool_call in message.tool_calls:
                    tool_call_map[tool_call.id] = tool_call.function.name
        
        # Find the most recent tool message (should be the last one in a tool result submission)
        most_recent_tool_message = None
        for message in reversed(input.messages):
            if hasattr(message, 'role') and message.role == "tool":
                most_recent_tool_message = message
                break
        
        if most_recent_tool_message:
            tool_name = tool_call_map.get(most_recent_tool_message.tool_call_id, "unknown")
            
            # Debug: Log the extracted tool message
            logger.debug(f"Extracted most recent ToolMessage: role={most_recent_tool_message.role}, tool_call_id={most_recent_tool_message.tool_call_id}, content='{most_recent_tool_message.content}'")
            
            return [{
                'tool_name': tool_name,
                'message': most_recent_tool_message
            }]
        
        return []
    
    async def _stream_events(
        self, 
        execution: ExecutionState
    ) -> AsyncGenerator[BaseEvent, None]:
        """Stream events from execution queue.
        
        Args:
            execution: The execution state
            
        Yields:
            AG-UI events from the queue
        """
        logger.debug(f"Starting _stream_events for thread {execution.thread_id}, queue ID: {id(execution.event_queue)}")
        event_count = 0
        timeout_count = 0
        
        while True:
            try:
                logger.debug(f"Waiting for event from queue (thread {execution.thread_id}, queue size: {execution.event_queue.qsize()})")
                
                # Wait for event with timeout
                event = await asyncio.wait_for(
                    execution.event_queue.get(),
                    timeout=1.0  # Check every second
                )
                
                event_count += 1
                logger.debug(f"Got event #{event_count} from queue: {type(event).__name__ if event else 'None'} (thread {execution.thread_id})")
                
                if event is None:
                    # Execution complete
                    execution.is_complete = True
                    logger.debug(f"Execution complete for thread {execution.thread_id} after {event_count} events")
                    break
                
                logger.debug(f"Streaming event #{event_count}: {type(event).__name__} (thread {execution.thread_id})")
                yield event
                
            except asyncio.TimeoutError:
                timeout_count += 1
                logger.debug(f"Timeout #{timeout_count} waiting for events (thread {execution.thread_id}, task done: {execution.task.done()}, queue size: {execution.event_queue.qsize()})")
                
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
                    try:
                        task_result = execution.task.result()
                        logger.debug(f"Task completed with result: {task_result} (thread {execution.thread_id})")
                    except Exception as e:
                        logger.debug(f"Task completed with exception: {e} (thread {execution.thread_id})")
                    
                    # Wait a bit more in case there are events still coming
                    logger.debug(f"Task done but no None signal - checking queue one more time (thread {execution.thread_id}, queue size: {execution.event_queue.qsize()})")
                    if execution.event_queue.qsize() > 0:
                        logger.debug(f"Found {execution.event_queue.qsize()} events in queue after task completion, continuing...")
                        continue
                    
                    logger.debug(f"Task completed without sending None signal (thread {execution.thread_id})")
                    break
    
    async def _start_new_execution(
        self, 
        input: RunAgentInput
    ) -> AsyncGenerator[BaseEvent, None]:
        """Start a new ADK execution with tool support.
        
        Args:
            input: The run input
            
        Yields:
            AG-UI events from the execution
        """
        try:
            # Emit RUN_STARTED
            logger.debug(f"Emitting RUN_STARTED for thread {input.thread_id}, run {input.run_id}")
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
                
                # Check if there's an existing execution for this thread and wait for it
                existing_execution = self._active_executions.get(input.thread_id)

            # If there was an existing execution, wait for it to complete
            if existing_execution and not existing_execution.is_complete:
                logger.debug(f"Waiting for existing execution to complete for thread {input.thread_id}")
                try:
                    await existing_execution.task
                except Exception as e:
                    logger.debug(f"Previous execution completed with error: {e}")
            
            # Start background execution
            execution = await self._start_background_execution(input)
            
            # Store execution (replacing any previous one)
            async with self._execution_lock:
                self._active_executions[input.thread_id] = execution
            
            # Stream events and track tool calls
            logger.debug(f"Starting to stream events for execution {execution.thread_id}")
            has_tool_calls = False
            tool_call_ids = []
            
            logger.debug(f"About to iterate over _stream_events for execution {execution.thread_id}")
            async for event in self._stream_events(execution):
                # Track tool calls for HITL scenarios
                if isinstance(event, ToolCallEndEvent):
                    logger.info(f"Detected ToolCallEndEvent with id: {event.tool_call_id}")
                    has_tool_calls = True
                    tool_call_ids.append(event.tool_call_id)

                # backend tools will always emit ToolCallResultEvent
                # If it is a backend tool then we don't need to add the tool_id in pending_tools
                if isinstance(event, ToolCallResultEvent) and event.tool_call_id in tool_call_ids:
                    logger.info(f"Detected ToolCallResultEvent with id: {event.tool_call_id}")
                    tool_call_ids.remove(event.tool_call_id)
                
                
                logger.debug(f"Yielding event: {type(event).__name__}")
                yield event
                
            logger.debug(f"Finished iterating over _stream_events for execution {execution.thread_id}")
            
            # If we found tool calls, add them to session state BEFORE cleanup
            if has_tool_calls:
                app_name = self._get_app_name(input)
                user_id = self._get_user_id(input)
                for tool_call_id in tool_call_ids:
                    await self._add_pending_tool_call_with_context(
                        execution.thread_id, tool_call_id, app_name, user_id
                    )
            logger.debug(f"Finished streaming events for execution {execution.thread_id}")
            
            # Emit RUN_FINISHED
            logger.debug(f"Emitting RUN_FINISHED for thread {input.thread_id}, run {input.run_id}")
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
            # Clean up execution if complete and no pending tool calls (HITL scenarios)
            async with self._execution_lock:
                if input.thread_id in self._active_executions:
                    execution = self._active_executions[input.thread_id]
                    execution.is_complete = True
                    
                    # Check if session has pending tool calls before cleanup
                    has_pending = await self._has_pending_tool_calls(input.thread_id)
                    if not has_pending:
                        del self._active_executions[input.thread_id]
                        logger.debug(f"Cleaned up execution for thread {input.thread_id}")
                    else:
                        logger.info(f"Preserving execution for thread {input.thread_id} - has pending tool calls (HITL scenario)")
    
    async def _start_background_execution(
        self, 
        input: RunAgentInput
    ) -> ExecutionState:
        """Start ADK execution in background with tool support.
        
        Args:
            input: The run input
            
        Returns:
            ExecutionState tracking the background execution
        """
        event_queue = asyncio.Queue()
        logger.debug(f"Created event queue {id(event_queue)} for thread {input.thread_id}")
        # Extract necessary information
        user_id = self._get_user_id(input)
        app_name = self._get_app_name(input)
        
        # Use the ADK agent directly
        adk_agent = self._adk_agent
        
        # Prepare agent modifications (SystemMessage and tools)
        agent_updates = {}
        
        # Handle SystemMessage if it's the first message - append to agent instructions
        if input.messages and isinstance(input.messages[0], SystemMessage):
            system_content = input.messages[0].content
            if system_content:
                current_instruction = getattr(adk_agent, 'instruction', '') or ''

                if callable(current_instruction):
                    # Handle instructions provider
                    if inspect.iscoroutinefunction(current_instruction):
                        # Async instruction provider
                        async def instruction_provider_wrapper_async(*args, **kwargs):
                            instructions = system_content
                            original_instructions = await current_instruction(*args, **kwargs) or ''
                            if original_instructions:
                                instructions = f"{original_instructions}\n\n{instructions}"
                            return instructions
                        new_instruction = instruction_provider_wrapper_async
                    else:
                        # Sync instruction provider
                        def instruction_provider_wrapper_sync(*args, **kwargs):
                            instructions = system_content
                            original_instructions = current_instruction(*args, **kwargs) or ''
                            if original_instructions:
                                instructions = f"{original_instructions}\n\n{instructions}"
                            return instructions
                        new_instruction = instruction_provider_wrapper_sync

                    logger.debug(
                        f"Will wrap callable InstructionProvider and append SystemMessage: '{system_content[:100]}...'")
                else:
                    # Handle string instructions
                    if current_instruction:
                        new_instruction = f"{current_instruction}\n\n{system_content}"
                    else:
                        new_instruction = system_content
                    logger.debug(f"Will append SystemMessage to string instructions: '{system_content[:100]}...'")

                agent_updates['instruction'] = new_instruction

        # Create dynamic toolset if tools provided and prepare tool updates
        toolset = None
        if input.tools:
            
            # Get existing tools from the agent
            existing_tools = []
            if hasattr(adk_agent, 'tools') and adk_agent.tools:
                existing_tools = list(adk_agent.tools) if isinstance(adk_agent.tools, (list, tuple)) else [adk_agent.tools]
            
            # if same tool is defined in frontend and backend then agent will only use the backend tool
            input_tools = []
            for input_tool in input.tools:
                # Check if this input tool's name matches any existing tool
                # Also exclude this specific tool call "transfer_to_agent" which is used internally by the adk to handoff to other agents
                if (not any(hasattr(existing_tool, '__name__') and input_tool.name == existing_tool.__name__
                        for existing_tool in existing_tools) and input_tool.name != 'transfer_to_agent'):
                    input_tools.append(input_tool)
                        
            toolset = ClientProxyToolset(
                ag_ui_tools=input_tools,
                event_queue=event_queue
            )

            # Combine existing tools with our proxy toolset
            combined_tools = existing_tools + [toolset]
            agent_updates['tools'] = combined_tools
            logger.debug(f"Will combine {len(existing_tools)} existing tools with proxy toolset")
        
        # Create a single copy of the agent with all updates if any modifications needed
        if agent_updates:
            adk_agent = adk_agent.model_copy(update=agent_updates)
            logger.debug(f"Created modified agent copy with updates: {list(agent_updates.keys())}")
        
        # Create background task
        logger.debug(f"Creating background task for thread {input.thread_id}")
        task = asyncio.create_task(
            self._run_adk_in_background(
                input=input,
                adk_agent=adk_agent,
                user_id=user_id,
                app_name=app_name,
                event_queue=event_queue
            )
        )
        logger.debug(f"Background task created for thread {input.thread_id}: {task}")
        
        return ExecutionState(
            task=task,
            thread_id=input.thread_id,
            event_queue=event_queue
        )
    
    async def _run_adk_in_background(
        self,
        input: RunAgentInput,
        adk_agent: BaseAgent,
        user_id: str,
        app_name: str,
        event_queue: asyncio.Queue
    ):
        """Run ADK agent in background, emitting events to queue.
        
        Args:
            input: The run input
            adk_agent: The ADK agent to run (already prepared with tools and SystemMessage)
            user_id: User ID
            app_name: App name
            event_queue: Queue for emitting events
        """
        runner: Optional[Runner] = None
        try:
            # Agent is already prepared with tools and SystemMessage instructions (if any)
            # from _start_background_execution, so no additional agent copying needed here

            # Create runner
            runner = self._create_runner(
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

            # this will always update the backend states with the frontend states
            # Recipe Demo Example: if there is a state "salt" in the ingredients state and in frontend user remove this salt state using UI from the ingredients list then our backend should also update these state changes as well to sync both the states
            await self._session_manager.update_session_state(input.thread_id,app_name,user_id,input.state)
            
            
            # Convert messages
            # only use this new_message if there is no tool response from the user
            new_message = await self._convert_latest_message(input)
            
            # if there is a tool response submission by the user then we need to only pass the tool response to the adk runner
            if self._is_tool_result_submission(input):
                tool_results = await self._extract_tool_results(input)
                parts = []
                for tool_msg in tool_results:
                    tool_call_id = tool_msg['message'].tool_call_id
                    content = tool_msg['message'].content
                    
                    # Debug: Log the actual tool message content we received
                    logger.debug(f"Received tool result for call {tool_call_id}: content='{content}', type={type(content)}")
                    
                    # Parse JSON content, handling empty or invalid JSON gracefully
                    try:
                        if content and content.strip():
                            result = json.loads(content)
                        else:
                            # Handle empty content as a success with empty result
                            result = {"success": True, "result": None}
                            logger.warning(f"Empty tool result content for tool call {tool_call_id}, using empty success result")
                    except json.JSONDecodeError as json_error:
                        # Handle invalid JSON by providing detailed error result
                        result = {
                            "error": f"Invalid JSON in tool result: {str(json_error)}", 
                            "raw_content": content,
                            "error_type": "JSON_DECODE_ERROR",
                            "line": getattr(json_error, 'lineno', None),
                            "column": getattr(json_error, 'colno', None)
                        }
                        logger.error(f"Invalid JSON in tool result for call {tool_call_id}: {json_error} at line {getattr(json_error, 'lineno', '?')}, column {getattr(json_error, 'colno', '?')}")
                    
                    updated_function_response_part = types.Part(
                    function_response=types.FunctionResponse(
                        id= tool_call_id,
                        name=tool_msg["tool_name"], 
                        response=result,
                    )
                )
                    parts.append(updated_function_response_part)
                new_message = types.Content(parts=parts, role='user')
            # Create event translator
            event_translator = EventTranslator()
            
            # Run ADK agent
            is_long_running_tool = False
            async for adk_event in runner.run_async(
                user_id=user_id,
                session_id=input.thread_id,
                new_message=new_message,
                run_config=run_config
            ):

                final_response = adk_event.is_final_response()
                has_content = adk_event.content and hasattr(adk_event.content, 'parts') and adk_event.content.parts

                # Check if this is a streaming chunk that needs regular processing
                is_streaming_chunk = (
                    getattr(adk_event, 'partial', False) or  # Explicitly marked as partial
                    (not getattr(adk_event, 'turn_complete', True)) or  # Live streaming not complete
                    (not final_response)  # Not marked as final by is_final_response()
                )

                # Prefer LRO routing when a long-running tool call is present
                has_lro_function_call = False
                try:
                    lro_ids = set(getattr(adk_event, 'long_running_tool_ids', []) or [])
                    if lro_ids and adk_event.content and getattr(adk_event.content, 'parts', None):
                        for part in adk_event.content.parts:
                            func = getattr(part, 'function_call', None)
                            func_id = getattr(func, 'id', None) if func else None
                            if func_id and func_id in lro_ids:
                                has_lro_function_call = True
                                break
                except Exception:
                    # Be conservative: if detection fails, do not block streaming path
                    has_lro_function_call = False

                # Process as streaming if it's a chunk OR if it has content but no finish_reason,
                # but only when there is no LRO function call present (LRO takes precedence)
                if (not has_lro_function_call) and (is_streaming_chunk or (has_content and not getattr(adk_event, 'finish_reason', None))):
                    # Regular translation path
                    async for ag_ui_event in event_translator.translate(
                        adk_event,
                        input.thread_id,
                        input.run_id
                    ):

                        logger.debug(f"Emitting event to queue: {type(ag_ui_event).__name__} (thread {input.thread_id}, queue size before: {event_queue.qsize()})")
                        await event_queue.put(ag_ui_event)
                        logger.debug(f"Event queued: {type(ag_ui_event).__name__} (thread {input.thread_id}, queue size after: {event_queue.qsize()})")
                else:
                    # LongRunning Tool events are usually emitted in final response
                    # Ensure any active streaming text message is closed BEFORE tool calls
                    async for end_event in event_translator.force_close_streaming_message():
                        await event_queue.put(end_event)
                        logger.debug(f"Event queued (forced close): {type(end_event).__name__} (thread {input.thread_id}, queue size after: {event_queue.qsize()})")

                    async for ag_ui_event in event_translator.translate_lro_function_calls(
                        adk_event
                    ):
                        await event_queue.put(ag_ui_event)
                        if ag_ui_event.type == EventType.TOOL_CALL_END:
                            is_long_running_tool = True
                        logger.debug(f"Event queued: {type(ag_ui_event).__name__} (thread {input.thread_id}, queue size after: {event_queue.qsize()})")
                    # hard stop the execution if we find any long running tool
                    if is_long_running_tool:
                        return
            # Force close any streaming messages
            async for ag_ui_event in event_translator.force_close_streaming_message():
                await event_queue.put(ag_ui_event)
            # moving states snapshot events after the text event clousure to avoid this error https://github.com/Contextable/ag-ui/issues/28
            final_state = await self._session_manager.get_session_state(input.thread_id,app_name,user_id)
            if final_state:
                ag_ui_event =  event_translator._create_state_snapshot_event(final_state)                    
                await event_queue.put(ag_ui_event)
            # Signal completion - ADK execution is done
            logger.debug(f"Background task sending completion signal for thread {input.thread_id}")
            await event_queue.put(None)
            logger.debug(f"Background task completion signal sent for thread {input.thread_id}")
            
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
            # Background task cleanup completed
            # Ensure the ADK runner releases any resources (e.g. toolsets)
            if runner is not None:
                close_method = getattr(runner, "close", None)
                if close_method is not None:
                    try:
                        close_result = close_method()
                        if inspect.isawaitable(close_result):
                            await close_result
                    except Exception as close_error:
                        logger.warning(
                            "Error while closing ADK runner for thread %s: %s",
                            input.thread_id,
                            close_error,
                        )
    
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

        # Clear session lookup cache
        self._session_lookup_cache.clear()

        # Stop session manager cleanup task
        await self._session_manager.stop_cleanup_task()
