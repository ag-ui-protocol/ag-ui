# src/adk_agent.py

"""Main ADKAgent implementation for bridging AG-UI Protocol with Google ADK."""
from ag_ui_adk.agui_toolset import AGUIToolset

from typing import Optional, Dict, Callable, Any, AsyncGenerator, List, Iterable, TYPE_CHECKING, Tuple, Union

if TYPE_CHECKING:
    from google.adk.apps import App
import time
import json
import asyncio
import inspect
from datetime import datetime

from ag_ui.core import (
    RunAgentInput, BaseEvent, EventType,
    RunStartedEvent, RunFinishedEvent, RunErrorEvent,
    ToolCallEndEvent, SystemMessage, ToolCallResultEvent,
    MessagesSnapshotEvent
)

from google.adk import Runner
from google.adk.agents import BaseAgent, LlmAgent, RunConfig as ADKRunConfig
from google.adk.agents.run_config import StreamingMode
from google.adk.agents.llm_agent import InstructionProvider, ToolUnion
from google.adk.sessions import BaseSessionService, InMemorySessionService
from google.adk.artifacts import BaseArtifactService, InMemoryArtifactService
from google.adk.memory import BaseMemoryService, InMemoryMemoryService
from google.adk.auth.credential_service.base_credential_service import BaseCredentialService
from google.adk.auth.credential_service.in_memory_credential_service import InMemoryCredentialService
from google.genai import types

from .event_translator import EventTranslator, adk_events_to_messages
from .session_manager import SessionManager, CONTEXT_STATE_KEY, INVOCATION_ID_STATE_KEY
from .execution_state import ExecutionState
from .client_proxy_toolset import ClientProxyToolset
from .config import PredictStateMapping
from .utils.converters import convert_message_content_to_parts

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
        cleanup_interval_seconds: int = 300,  # 5 minutes default
        max_sessions_per_user: Optional[int] = None,    # No limit by default
        delete_session_on_cleanup: bool = True,
        save_session_to_memory_on_cleanup: bool = True,

        # Predictive state configuration
        predict_state: Optional[Iterable[PredictStateMapping]] = None,

        # Message snapshot configuration
        emit_messages_snapshot: bool = False,
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
            cleanup_interval_seconds: Interval for session cleanup
            max_sessions_per_user: Maximum concurrent sessions per user (None = unlimited)
            delete_session_on_cleanup: Whether to delete sessions from the adk SessionService on session cache cleanup
            save_session_to_memory_on_cleanup: Whether to save sessions to the adk MemoryService on session cache cleanup
            predict_state: Configuration for predictive state updates. When provided,
                the agent will emit PredictState CustomEvents for matching tool calls,
                enabling the UI to show state changes in real-time as tool arguments
                are streamed. Use PredictStateMapping to define which tool arguments
                map to which state keys.
            emit_messages_snapshot: Whether to emit a MessagesSnapshotEvent at the end
                of each run containing the full conversation history. Defaults to False
                to preserve existing behavior. Set to True for clients that need the
                full message history (e.g., for client-side persistence or AG-UI
                protocol compliance). Note: Clients using CopilotKit can use the
                /agents/state endpoint instead for on-demand history retrieval.

            Note:
            If delete_session_on_cleanup=False but save_session_to_memory_on_cleanup=True, sessions will accumulate in SessionService but still be saved to memory on cleanup.
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
            max_sessions_per_user=max_sessions_per_user,
            delete_session_on_cleanup=delete_session_on_cleanup,
            save_session_to_memory_on_cleanup=save_session_to_memory_on_cleanup
        )
        
        # Tool execution tracking
        self._active_executions: Dict[str, ExecutionState] = {}
        self._execution_timeout = execution_timeout_seconds
        self._tool_timeout = tool_timeout_seconds
        self._max_concurrent = max_concurrent_executions
        self._execution_lock = asyncio.Lock()

        # Session lookup cache for efficient thread_id to session metadata mapping
        # Maps thread_id -> (session_id, app_name, user_id)
        self._session_lookup_cache: Dict[str, Tuple[str, str, str]] = {}

        # Predictive state configuration for real-time state updates
        self._predict_state = predict_state
        # Message snapshot configuration
        self._emit_messages_snapshot = emit_messages_snapshot

        # App-based configuration (set by from_app() classmethod)
        self._app: Optional["App"] = None
        self._plugin_close_timeout: float = 5.0

        # Event translator will be created per-session for thread safety

        # Cleanup is managed by the session manager
        # Will start when first async operation runs

    def _is_adk_resumable(self) -> bool:
        """Check if ADK's native resumability is enabled via App.

        When using ADK's ResumabilityConfig(is_resumable=True), the Runner
        automatically persists FunctionCall events before pausing. This allows
        us to let ADK handle the pause/resume flow naturally instead of
        returning early at LRO tool calls.

        Returns:
            True if using from_app() with ResumabilityConfig.is_resumable=True
        """
        if self._app is None:
            return False
        resumability_config = getattr(self._app, 'resumability_config', None)
        if resumability_config is None:
            return False
        return getattr(resumability_config, 'is_resumable', False)

    @classmethod
    def from_app(
        cls,
        app: "App",
        # User identification (still needed - not in App)
        user_id: Optional[str] = None,
        user_id_extractor: Optional[Callable[[RunAgentInput], str]] = None,
        # ADK Services (App does NOT contain these - still passed to Runner separately)
        session_service: Optional[BaseSessionService] = None,
        artifact_service: Optional[BaseArtifactService] = None,
        memory_service: Optional[BaseMemoryService] = None,
        credential_service: Optional[BaseCredentialService] = None,
        # Configuration
        run_config_factory: Optional[Callable[[RunAgentInput], ADKRunConfig]] = None,
        use_in_memory_services: bool = True,
        plugin_close_timeout: float = 5.0,
        # Execution limits
        execution_timeout_seconds: int = 600,
        tool_timeout_seconds: int = 300,
        max_concurrent_executions: int = 10,
        # Session management
        session_timeout_seconds: Optional[int] = 1200,
        cleanup_interval_seconds: int = 300,
        max_sessions_per_user: Optional[int] = None,    # No limit by default
        delete_session_on_cleanup: bool = True,
        save_session_to_memory_on_cleanup: bool = True,
        # AG-UI specific
        predict_state: Optional[Iterable[PredictStateMapping]] = None,
        emit_messages_snapshot: bool = False,
    ) -> "ADKAgent":
        """Create ADKAgent from an ADK App instance.

        This is the recommended way to create an ADKAgent when you want access to
        App-level features like resumability, context caching, and plugins.

        The App object bundles together the root agent, plugins, and configuration
        that would otherwise need to be passed separately. Using from_app() enables:
        - Plugin support (logging, tracing, custom plugins)
        - Resumability configuration for pause/resume workflows
        - Context caching configuration for LLM optimization
        - Events compaction configuration

        Args:
            app: The ADK App instance containing the root agent and configuration
            user_id: Static user ID for all requests
            user_id_extractor: Function to extract user ID dynamically from input
            session_service: Session management service (defaults to InMemorySessionService)
            artifact_service: File/artifact storage service
            memory_service: Conversation memory and search service
            credential_service: Authentication credential storage
            run_config_factory: Function to create RunConfig per request
            use_in_memory_services: Use in-memory implementations for unspecified services
            plugin_close_timeout: Timeout for plugin close methods (requires ADK 1.19+)
            execution_timeout_seconds: Timeout for entire execution
            tool_timeout_seconds: Timeout for individual tool calls
            max_concurrent_executions: Maximum concurrent background executions
            session_timeout_seconds: Session timeout in seconds
            cleanup_interval_seconds: Interval for session cleanup
            predict_state: Configuration for predictive state updates
            emit_messages_snapshot: Whether to emit MessagesSnapshotEvent at end of runs

        Returns:
            ADKAgent instance configured to use the App

        Example:
            from google.adk.apps import App
            from google.adk.agents import Agent

            app = App(
                name="my_assistant",
                root_agent=Agent(name="assistant", model="gemini-2.5-flash", ...),
                plugins=[LoggingPlugin()],
            )
            agent = ADKAgent.from_app(app, user_id="demo_user")
        """
        # Import App at runtime to avoid circular imports
        from google.adk.apps import App as AppClass

        if not isinstance(app, AppClass):
            raise TypeError(f"Expected App instance, got {type(app).__name__}")

        instance = cls(
            adk_agent=app.root_agent,
            app_name=app.name,
            user_id=user_id,
            user_id_extractor=user_id_extractor,
            session_service=session_service,
            artifact_service=artifact_service,
            memory_service=memory_service,
            credential_service=credential_service,
            run_config_factory=run_config_factory,
            use_in_memory_services=use_in_memory_services,
            execution_timeout_seconds=execution_timeout_seconds,
            tool_timeout_seconds=tool_timeout_seconds,
            max_concurrent_executions=max_concurrent_executions,
            session_timeout_seconds=session_timeout_seconds,
            cleanup_interval_seconds=cleanup_interval_seconds,
            max_sessions_per_user=max_sessions_per_user,
            delete_session_on_cleanup=delete_session_on_cleanup,
            save_session_to_memory_on_cleanup=save_session_to_memory_on_cleanup,
            predict_state=predict_state,
            emit_messages_snapshot=emit_messages_snapshot,
        )
        # Store App for per-request App creation with modified agents
        instance._app = app
        instance._plugin_close_timeout = plugin_close_timeout
        return instance

    def _get_session_metadata(self, thread_id: str) -> Optional[Tuple[str, str, str]]:
        """Get session metadata for a thread_id efficiently.

        Args:
            thread_id: The AG-UI thread_id to lookup

        Returns:
            Tuple of (session_id, app_name, user_id) or None if not found
        """
        return self._session_lookup_cache.get(thread_id)

    def _get_backend_session_id(self, thread_id: str) -> Optional[str]:
        """Get the backend session_id for a thread_id.

        Args:
            thread_id: The AG-UI thread_id to lookup

        Returns:
            The backend session_id or None if not found
        """
        metadata = self._session_lookup_cache.get(thread_id)
        return metadata[0] if metadata else None
    
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
    
    async def _add_pending_tool_call_with_context(self, thread_id: str, tool_call_id: str, app_name: str, user_id: str):
        """Add a tool call to the session's pending list for HITL tracking.

        Args:
            thread_id: The AG-UI thread_id
            tool_call_id: The tool call ID to track
            app_name: App name (for session lookup)
            user_id: User ID (for session lookup)
        """
        # Get the backend session_id from cache
        metadata = self._get_session_metadata(thread_id)
        if not metadata:
            logger.warning(f"No session metadata for thread {thread_id}, cannot add pending tool call")
            return

        session_id, _, _ = metadata
        logger.debug(f"Adding pending tool call {tool_call_id} for thread {thread_id} (session {session_id})")
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
                    logger.info(f"Added tool call {tool_call_id} to thread {thread_id} pending list")
        except Exception as e:
            logger.error(f"Failed to add pending tool call {tool_call_id} to thread {thread_id}: {e}")

    async def _remove_pending_tool_call(self, thread_id: str, tool_call_id: str):
        """Remove a tool call from the session's pending list.

        Args:
            thread_id: The AG-UI thread_id
            tool_call_id: The tool call ID to remove
        """
        try:
            # Use efficient session metadata lookup
            metadata = self._get_session_metadata(thread_id)

            if metadata:
                session_id, app_name, user_id = metadata

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
                        logger.info(f"Removed tool call {tool_call_id} from thread {thread_id} pending list")
        except Exception as e:
            logger.error(f"Failed to remove pending tool call {tool_call_id} from thread {thread_id}: {e}")
    
    async def _get_pending_tool_call_ids(self, thread_id: str) -> Optional[List[str]]:
        """Fetch the pending tool call identifiers tracked for a thread."""
        try:
            metadata = self._get_session_metadata(thread_id)

            if metadata:
                session_id, app_name, user_id = metadata
                pending_calls = await self._session_manager.get_state_value(
                    session_id=session_id,
                    app_name=app_name,
                    user_id=user_id,
                    key="pending_tool_calls",
                    default=[],
                )

                if pending_calls is None:
                    return []

                return list(pending_calls)
        except Exception as e:
            logger.error(f"Failed to fetch pending tool calls for thread {thread_id}: {e}")

        return None

    async def _has_pending_tool_calls(self, thread_id: str) -> bool:
        """Check if thread has pending tool calls (HITL scenario).

        Args:
            thread_id: The AG-UI thread_id

        Returns:
            True if thread has pending tool calls
        """
        pending_calls = await self._get_pending_tool_call_ids(thread_id)
        if pending_calls is None:
            return False

        return len(pending_calls) > 0
    
    
    def _default_run_config(self, input: RunAgentInput) -> ADKRunConfig:
        """Create default RunConfig with SSE streaming enabled.

        Context from RunAgentInput is always stored in session state under the
        '_ag_ui_context' key (CONTEXT_STATE_KEY), making it accessible to both
        tools (via tool_context.state) and instruction providers (via ctx.state).

        Additionally, for ADK 1.22.0+, context is also included in RunConfig's
        custom_metadata field, providing an alternative access pattern via
        ctx.run_config.custom_metadata['ag_ui_context'].
        """
        config_kwargs = {
            'streaming_mode': StreamingMode.SSE,
            'save_input_blobs_as_artifacts': True,
        }

        # For ADK 1.22.0+, also include context in custom_metadata
        if self._run_config_supports_custom_metadata() and input.context:
            config_kwargs['custom_metadata'] = {
                'ag_ui_context': [
                    {"description": ctx.description, "value": ctx.value}
                    for ctx in input.context
                ]
            }

        return ADKRunConfig(**config_kwargs)

    def _run_config_supports_custom_metadata(self) -> bool:
        """Check if the installed ADK version supports custom_metadata in RunConfig.

        The custom_metadata parameter was added to RunConfig in ADK 1.22.0.
        This method checks for its presence to maintain backward compatibility.

        Returns:
            True if RunConfig accepts custom_metadata, False otherwise
        """
        sig = inspect.signature(ADKRunConfig.__init__)
        return 'custom_metadata' in sig.parameters

    def _runner_supports_plugin_close_timeout(self) -> bool:
        """Check if the installed ADK version supports plugin_close_timeout.

        The plugin_close_timeout parameter was added to Runner in ADK 1.19.0.
        This method checks for its presence to maintain backward compatibility.

        Returns:
            True if Runner accepts plugin_close_timeout, False otherwise
        """
        sig = inspect.signature(Runner.__init__)
        return 'plugin_close_timeout' in sig.parameters

    def _create_runner(self, adk_agent: BaseAgent, user_id: str, app_name: str) -> Runner:
        """Create a new runner instance.

        If an App was provided via from_app(), creates a per-request App copy
        with the modified agent to preserve App-level configurations (plugins,
        resumability, context caching, etc.).

        Args:
            adk_agent: The (potentially modified) agent to run
            user_id: User ID for the session
            app_name: Application name for the session

        Returns:
            Configured Runner instance
        """
        # Build common kwargs for services
        service_kwargs = {
            'session_service': self._session_manager._session_service,
            'artifact_service': self._artifact_service,
            'memory_service': self._memory_service,
            'credential_service': self._credential_service,
        }

        # Add plugin_close_timeout if supported by this ADK version
        if self._runner_supports_plugin_close_timeout():
            service_kwargs['plugin_close_timeout'] = self._plugin_close_timeout

        if self._app is not None:
            # Create per-request App copy with modified agent (preserves all App configs)
            request_app = self._app.model_copy(update={'root_agent': adk_agent})
            return Runner(app=request_app, **service_kwargs)
        else:
            # Old style: component-based (no plugins support - use from_app() for that)
            return Runner(
                app_name=app_name,
                agent=adk_agent,
                **service_kwargs,
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
        unseen_messages = await self._get_unseen_messages(input)

        if not unseen_messages:
            # No unseen messages – fall through to normal execution handling
            async for event in self._start_new_execution(input):
                yield event
            return

        index = 0
        total_unseen = len(unseen_messages)
        app_name = self._get_app_name(input)
        skip_tool_message_batch = False

        # Check if there are pending tool calls AND tool results in unseen messages
        has_pending_tools = await self._has_pending_tool_calls(input.thread_id)
        has_tool_results_in_unseen = any(getattr(msg, "role", None) == "tool" for msg in unseen_messages)

        if has_pending_tools and has_tool_results_in_unseen:
            # HITL/Frontend tool scenario: skip to the tool results first
            # Get backend session_id (should exist since we have pending tools)
            backend_session_id = self._get_backend_session_id(input.thread_id)
            for i, msg in enumerate(unseen_messages):
                if getattr(msg, "role", None) == "tool":
                    # Mark all messages before the tool result as processed (they're already in the ADK session)
                    skipped_ids = []
                    for j in range(i):
                        msg_id = getattr(unseen_messages[j], "id", None)
                        if msg_id:
                            skipped_ids.append(msg_id)
                    if skipped_ids:
                        self._session_manager.mark_messages_processed(app_name, input.thread_id, skipped_ids)
                    index = i
                    break

        logger.debug(f"[RUN_LOOP] Starting message loop for thread={input.thread_id}, total_unseen={total_unseen}, starting_index={index}")

        while index < total_unseen:
            current = unseen_messages[index]
            role = getattr(current, "role", None)

            if role == "tool":
                tool_batch: List[Any] = []
                while index < total_unseen and getattr(unseen_messages[index], "role", None) == "tool":
                    tool_batch.append(unseen_messages[index])
                    index += 1

                tool_call_ids = [
                    getattr(message, "tool_call_id", None)
                    for message in tool_batch
                    if getattr(message, "tool_call_id", None)
                ]
                pending_tool_call_ids = await self._get_pending_tool_call_ids(input.thread_id)

                should_process_tool_batch = True
                if pending_tool_call_ids is not None:
                    if tool_call_ids:
                        pending_tool_call_id_set = set(pending_tool_call_ids)
                        should_process_tool_batch = any(
                            tool_call_id in pending_tool_call_id_set
                            for tool_call_id in tool_call_ids
                        )
                    else:
                        should_process_tool_batch = len(pending_tool_call_ids) > 0

                if not should_process_tool_batch:
                    logger.info(
                        "Skipping tool result batch for thread %s - no matching pending tool calls",
                        input.thread_id,
                    )
                    message_ids = self._collect_message_ids(tool_batch)
                    if message_ids:
                        self._session_manager.mark_messages_processed(
                            app_name,
                            input.thread_id,
                            message_ids,
                        )
                    skip_tool_message_batch = False
                    continue

                # Peek ahead: if there's a non-tool message following, collect it too
                # This allows sending FunctionResponse + user message in ONE invocation
                trailing_messages: List[Any] = []
                trailing_assistant_ids: List[str] = []
                temp_index = index

                # Collect all trailing non-tool messages (skip assistant messages, collect user/system)
                while temp_index < total_unseen and getattr(unseen_messages[temp_index], "role", None) != "tool":
                    candidate = unseen_messages[temp_index]
                    candidate_role = getattr(candidate, "role", None)

                    if candidate_role == "assistant":
                        message_id = getattr(candidate, "id", None)
                        if message_id:
                            trailing_assistant_ids.append(message_id)
                    else:
                        trailing_messages.append(candidate)

                    temp_index += 1

                # If we found trailing messages, advance index and mark assistants as processed
                if trailing_messages or trailing_assistant_ids:
                    index = temp_index

                    if trailing_assistant_ids:
                        self._session_manager.mark_messages_processed(
                            app_name,
                            input.thread_id,
                            trailing_assistant_ids,
                        )

                async for event in self._handle_tool_result_submission(
                    input,
                    tool_messages=tool_batch,
                    trailing_messages=trailing_messages if trailing_messages else None,
                    include_message_batch=not skip_tool_message_batch,
                ):
                    yield event
                skip_tool_message_batch = False
            else:
                message_batch: List[Any] = []
                assistant_message_ids: List[str] = []

                while index < total_unseen and getattr(unseen_messages[index], "role", None) != "tool":
                    candidate = unseen_messages[index]
                    candidate_role = getattr(candidate, "role", None)

                    if candidate_role == "assistant":
                        message_id = getattr(candidate, "id", None)
                        if message_id:
                            assistant_message_ids.append(message_id)
                    else:
                        message_batch.append(candidate)

                    index += 1

                if assistant_message_ids:
                    self._session_manager.mark_messages_processed(
                        app_name,
                        input.thread_id,
                        assistant_message_ids,
                    )

                if not message_batch:
                    if assistant_message_ids:
                        skip_tool_message_batch = True
                    continue
                else:
                    skip_tool_message_batch = False

                # Check if there's an upcoming tool batch that will be skipped
                # If so, this non-tool batch is part of historical backend tool interaction
                # and should also be skipped
                upcoming_tool_batch_skipped = False
                if index < total_unseen and getattr(unseen_messages[index], "role", None) == "tool":
                    # Peek at the upcoming tool batch
                    peek_idx = index
                    upcoming_tool_call_ids = []
                    while peek_idx < total_unseen and getattr(unseen_messages[peek_idx], "role", None) == "tool":
                        tool_call_id = getattr(unseen_messages[peek_idx], "tool_call_id", None)
                        if tool_call_id:
                            upcoming_tool_call_ids.append(tool_call_id)
                        peek_idx += 1

                    if upcoming_tool_call_ids:
                        pending_ids = await self._get_pending_tool_call_ids(input.thread_id)
                        if pending_ids is not None:
                            pending_set = set(pending_ids)
                            # If NONE of the upcoming tool results match pending, they're historical
                            if not any(tc_id in pending_set for tc_id in upcoming_tool_call_ids):
                                upcoming_tool_batch_skipped = True

                if upcoming_tool_batch_skipped:
                    # Skip this message batch - it's part of historical backend tool interaction
                    # Mark the messages as processed
                    logger.debug(f"[RUN_LOOP] Skipping message batch (upcoming tool batch will be skipped)")
                    batch_ids = self._collect_message_ids(message_batch)
                    if batch_ids:
                        self._session_manager.mark_messages_processed(app_name, input.thread_id, batch_ids)
                    continue

                logger.debug(f"[RUN_LOOP] Calling _start_new_execution with message_batch of {len(message_batch)} messages")
                async for event in self._start_new_execution(input, message_batch=message_batch):
                    yield event
    
    async def _ensure_session_exists(self, app_name: str, user_id: str, thread_id: str, initial_state: dict) -> Tuple[Any, str]:
        """Ensure a session exists, creating it if necessary via session manager.

        Args:
            app_name: Application name
            user_id: User identifier
            thread_id: The AG-UI thread_id (client-provided identifier)
            initial_state: Initial state for new sessions

        Returns:
            Tuple of (session, backend_session_id)
        """
        # Check cache first
        cached = self._session_lookup_cache.get(thread_id)
        if cached:
            session_id, cached_app_name, cached_user_id = cached
            # Verify session still exists
            session = await self._session_manager.get_session(session_id, cached_app_name, cached_user_id)
            if session:
                logger.debug(f"Session cache hit for thread {thread_id}: {session_id}")
                return session, session_id

        # Cache miss or stale - resolve via SessionManager
        try:
            session, backend_session_id = await self._session_manager.get_or_create_session(
                thread_id=thread_id,
                app_name=app_name,
                user_id=user_id,
                initial_state=initial_state
            )

            # Cache the mapping as tuple: (session_id, app_name, user_id)
            self._session_lookup_cache[thread_id] = (backend_session_id, app_name, user_id)

            logger.debug(f"Session ready for thread {thread_id}: {backend_session_id}")
            return session, backend_session_id
        except Exception as e:
            logger.error(f"Failed to ensure session for thread {thread_id}: {e}")
            raise

    async def _convert_latest_message(
        self,
        input: RunAgentInput,
        messages: Optional[List[Any]] = None,
    ) -> Optional[types.Content]:
        """Convert the latest user message to ADK Content format."""
        target_messages = messages if messages is not None else input.messages

        if not target_messages:
            return None

        # Get the latest user message
        for message in reversed(target_messages):
            if getattr(message, "role", None) == "user" and getattr(message, "content", None):
                parts = convert_message_content_to_parts(getattr(message, "content", None))
                if not parts:
                    return None
                return types.Content(role="user", parts=parts)

        return None
    
    
    async def _get_unseen_messages(self, input: RunAgentInput) -> List[Any]:
        """Return messages that have not yet been processed for this session.

        Filters out ALL processed messages, not just stopping at the first one.
        This handles out-of-order message processing (e.g., LRO tool results arriving
        after subsequent user messages).
        """
        if not input.messages:
            return []

        app_name = self._get_app_name(input)
        session_id = input.thread_id
        processed_ids = self._session_manager.get_processed_message_ids(app_name, session_id)

        # Filter out all processed messages, maintaining chronological order
        unseen: List[Any] = []
        for message in input.messages:
            message_id = getattr(message, "id", None)
            if message_id and message_id in processed_ids:
                continue
            # For ToolMessages, also check if tool_call_id is processed (fixes #437 replay bug)
            # Backend tool results mark their tool_call_id as processed when completed
            tool_call_id = getattr(message, "tool_call_id", None)
            if tool_call_id and tool_call_id in processed_ids:
                continue
            unseen.append(message)

        return unseen

    def _collect_message_ids(self, messages: List[Any]) -> List[str]:
        """Extract message IDs from messages, skipping those without IDs."""
        return [getattr(message, "id") for message in messages if getattr(message, "id", None)]

    async def _is_tool_result_submission(
        self,
        input: RunAgentInput,
        unseen_messages: Optional[List[Any]] = None,
    ) -> bool:
        """Check if this request contains tool results.

        Args:
            input: The run input
            unseen_messages: Optional list of unseen messages to inspect

        Returns:
            True if all unseen messages are tool results
        """
        unseen_messages = unseen_messages if unseen_messages is not None else await self._get_unseen_messages(input)

        if not unseen_messages:
            return False

        last_message = unseen_messages[-1]
        return getattr(last_message, "role", None) == "tool"

    async def _handle_tool_result_submission(
        self,
        input: RunAgentInput,
        *,
        tool_messages: Optional[List[Any]] = None,
        trailing_messages: Optional[List[Any]] = None,
        include_message_batch: bool = True,
    ) -> AsyncGenerator[BaseEvent, None]:
        """Handle tool result submission for existing execution.

        Args:
            input: The run input containing tool results
            tool_messages: Optional pre-filtered tool messages to consider
            trailing_messages: Optional messages that follow the tool batch (e.g., user message)
            include_message_batch: Whether to forward the candidate messages to the execution

        Yields:
            AG-UI events from continued execution
        """
        thread_id = input.thread_id
        app_name = self._get_app_name(input)

        # Extract tool results that are sent by the frontend
        # Note: _extract_tool_results filters out 'confirm_changes' synthetic tool results
        candidate_messages = tool_messages if tool_messages is not None else await self._get_unseen_messages(input)
        tool_results = await self._extract_tool_results(input, candidate_messages)

        # Check if there were actual tool messages that were filtered out
        # (i.e., synthetic confirm_changes tool results)
        actual_tool_messages = [
            msg for msg in candidate_messages
            if hasattr(msg, 'role') and msg.role == "tool"
        ]

        # If all tool results were filtered out (e.g., only confirm_changes messages),
        # we still need to mark those messages as processed and continue with trailing messages
        if not tool_results and actual_tool_messages:
            # Mark the tool messages as processed (they were confirm_changes results)
            tool_message_ids = self._collect_message_ids(actual_tool_messages)
            if tool_message_ids:
                self._session_manager.mark_messages_processed(app_name, thread_id, tool_message_ids)
                logger.debug(
                    "Marked %d synthetic tool result messages as processed for thread %s",
                    len(tool_message_ids),
                    thread_id,
                )

            # If we have trailing messages (e.g., a follow-up user request after confirming changes),
            # process them as a new execution
            if trailing_messages:
                logger.debug(
                    "All tool results were synthetic (confirm_changes); processing %d trailing messages",
                    len(trailing_messages),
                )
                async for event in self._start_new_execution(
                    input,
                    tool_results=None,
                    message_batch=trailing_messages,
                ):
                    yield event
                return

            # No tool results and no trailing messages - nothing to do
            # This is not an error; the user just approved/rejected changes without sending a follow-up.
            # We still need to emit RUN_STARTED/RUN_FINISHED so the client receives a
            # valid, terminal-event-bearing stream (prevents INCOMPLETE_STREAM errors).
            logger.debug(
                "All tool results were synthetic (confirm_changes) with no trailing messages for thread %s",
                thread_id,
            )
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=thread_id,
                run_id=input.run_id,
            )
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=thread_id,
                run_id=input.run_id,
            )
            return

        # If there were no actual tool messages at all, this is an error
        if not tool_results:
            logger.error(f"Tool result submission without tool results for thread {thread_id}")
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message="No tool results found in submission",
                code="NO_TOOL_RESULTS"
            )
            return

        try:
            # Remove tool calls from pending list and track which ones we processed
            processed_tool_ids = []
            for tool_result in tool_results:
                tool_call_id = tool_result['message'].tool_call_id
                has_pending = await self._has_pending_tool_calls(thread_id)

                if has_pending:
                    # Remove from pending tool calls now that we're processing it
                    await self._remove_pending_tool_call(thread_id, tool_call_id)
                    processed_tool_ids.append(tool_call_id)

            # Since all tools are long-running, all tool results are standalone
            # and should start new executions with the tool results

            # Use trailing_messages if provided, otherwise fall back to candidate_messages
            message_batch = trailing_messages if trailing_messages else (candidate_messages if include_message_batch else None)

            async for event in self._start_new_execution(
                input,
                tool_results=tool_results,
                message_batch=message_batch,
            ):
                yield event

        except Exception as e:
            logger.error(f"Error handling tool results: {e}", exc_info=True)
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=f"Failed to process tool results: {str(e)}",
                code="TOOL_RESULT_PROCESSING_ERROR"
            )
    
    async def _extract_tool_results(
        self,
        input: RunAgentInput,
        candidate_messages: Optional[List[Any]] = None,
    ) -> List[Dict]:
        """Extract tool messages with their names from input.

        Only extracts tool messages provided in candidate_messages. When no
        candidates are supplied, all messages are considered.

        IMPORTANT: This method filters out 'confirm_changes' tool results.
        'confirm_changes' is a synthetic tool call emitted by the middleware
        to trigger the frontend's confirmation UI dialog. ADK never actually
        called this tool, so we must NOT send its result back to ADK - doing
        so would cause "No function call event found for function responses ids"
        errors because ADK's session has no matching FunctionCall.

        Args:
            input: The run input
            candidate_messages: Optional subset of messages to inspect

        Returns:
            List of dicts containing tool name and message ordered chronologically
        """
        # Create a mapping of tool_call_id to tool name
        tool_call_map = {}
        for message in input.messages:
            if hasattr(message, 'tool_calls') and message.tool_calls:
                for tool_call in message.tool_calls:
                    tool_call_map[tool_call.id] = tool_call.function.name

        messages_to_check = candidate_messages or input.messages
        extracted_results: List[Dict] = []

        for message in messages_to_check:
            if hasattr(message, 'role') and message.role == "tool":
                tool_name = tool_call_map.get(getattr(message, 'tool_call_id', None), "unknown")

                # Skip 'confirm_changes' tool results - this is a synthetic tool call
                # emitted by the middleware to trigger the frontend confirmation dialog.
                # ADK never called this tool, so we must not send its result to ADK.
                if tool_name == "confirm_changes":
                    logger.debug(
                        "Skipping confirm_changes tool result (synthetic tool): tool_call_id=%s",
                        getattr(message, 'tool_call_id', None),
                    )
                    continue

                logger.debug(
                    "Extracted ToolMessage: role=%s, tool_call_id=%s, content='%s'",
                    getattr(message, 'role', None),
                    getattr(message, 'tool_call_id', None),
                    getattr(message, 'content', None),
                )
                extracted_results.append({
                    'tool_name': tool_name,
                    'message': message
                })

        return extracted_results

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
        input: RunAgentInput,
        *,
        tool_results: Optional[List[Dict]] = None,
        message_batch: Optional[List[Any]] = None,
    ) -> AsyncGenerator[BaseEvent, None]:
        """Start a new ADK execution with tool support.

        Args:
            input: The run input

        Yields:
            AG-UI events from the execution
        """
        # Log execution context for debugging
        tool_result_ids = [tr['message'].tool_call_id for tr in tool_results] if tool_results else []
        message_batch_len = len(message_batch) if message_batch else 0
        exec_type = "HITL_RESUME" if tool_results else "NEW_RUN"
        logger.info(f"[EXEC] {exec_type} - thread={input.thread_id}, run={input.run_id}, tool_results={tool_result_ids}, message_batch_len={message_batch_len}")

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
            execution = await self._start_background_execution(
                input,
                tool_results=tool_results,
                message_batch=message_batch,
            )
            
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
                    # Mark tool_call_id as processed so replay will skip it (fixes #437 replay bug)
                    self._session_manager.mark_messages_processed(
                        self._get_app_name(input), execution.thread_id, [event.tool_call_id]
                    )

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
    
    async def _start_background_execution(
        self,
        input: RunAgentInput,
        *,
        tool_results: Optional[List[Dict]] = None,
        message_batch: Optional[List[Any]] = None,
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
        
        # Use a deep copy of the ADK agent so we can modify it per-execution
        adk_agent = self._adk_agent.model_copy(deep=True)

        # Handle SystemMessage if it's the first message - append to agent instructions
        if input.messages and isinstance(input.messages[0], SystemMessage):
            system_content = input.messages[0].content
            if system_content and isinstance(adk_agent, LlmAgent):
                current_instruction = adk_agent.instruction

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

                adk_agent.instruction = new_instruction

        # Log tools available from frontend
        tool_names = [t.name for t in input.tools] if input.tools else []
        logger.info(f"Tools from frontend: {tool_names}")

        # Track all ClientProxyToolset instances for collecting accumulated predictive state
        client_proxy_toolsets: list[ClientProxyToolset] = []

        def _update_agent_tools_recursive(agent: Any) -> None:
            """
            Recursively replace AGUIToolset with ClientProxyToolset for an agent and its sub-agents.
            Args:
                agent: Agent instance to process
            """
            nonlocal client_proxy_toolsets
            logger.info(f"[TOOL_SETUP] Processing agent: {agent.name} (type: {type(agent).__name__})")

            if isinstance(agent, LlmAgent) and hasattr(agent, "tools"):
                new_tools: list[ToolUnion] = []
                original_tool_count = len(agent.tools) if agent.tools else 0
                logger.info(f"[TOOL_SETUP] Agent {agent.name} has {original_tool_count} tools before replacement")

                for tool in agent.tools:
                    if isinstance(tool, AGUIToolset):
                        logger.info(f"[TOOL_SETUP] Agent {agent.name}: Found AGUIToolset with filter={tool.tool_filter}")
                        proxy_toolset = ClientProxyToolset(
                            ag_ui_tools=input.tools,
                            event_queue=event_queue,
                            tool_filter=tool.tool_filter,
                            tool_name_prefix=tool.tool_name_prefix,
                            predict_state=self._predict_state,
                        )
                        client_proxy_toolsets.append(proxy_toolset)
                        tool = proxy_toolset
                        logger.info(
                            f"[TOOL_SETUP] Replaced AGUIToolset with ClientProxyToolset for agent {agent.name}"
                        )
                    new_tools.append(tool)

                agent.tools = new_tools
                logger.info(f"[TOOL_SETUP] Agent {agent.name} now has {len(new_tools)} tools after replacement")

            # Recursively process sub-agents if they exist
            # This handles SequentialAgent, LoopAgent, and other composite agents
            sub_agents = getattr(agent, "sub_agents", None)
            if sub_agents and isinstance(sub_agents, (list, tuple)):
                logger.info(f"[TOOL_SETUP] Agent {agent.name} has {len(sub_agents)} sub-agents")
                for sub_agent in sub_agents:
                    _update_agent_tools_recursive(sub_agent)

        _update_agent_tools_recursive(adk_agent)

        # Create background task
        logger.debug(f"Creating background task for thread {input.thread_id}")
        run_kwargs = {
            "input": input,
            "adk_agent": adk_agent,
            "user_id": user_id,
            "app_name": app_name,
            "event_queue": event_queue,
            "client_proxy_toolsets": client_proxy_toolsets,
        }

        if tool_results is not None:
            run_kwargs["tool_results"] = tool_results

        if message_batch is not None:
            run_kwargs["message_batch"] = message_batch

        task = asyncio.create_task(self._run_adk_in_background(**run_kwargs))
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
        event_queue: asyncio.Queue,
        client_proxy_toolsets: List[ClientProxyToolset],
        tool_results: Optional[List[Dict]] = None,
        message_batch: Optional[List[Any]] = None,
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
        logger.debug(f"[BG_EXEC] _run_adk_in_background called for thread={input.thread_id}")
        logger.debug(f"[BG_EXEC]   tool_results={len(tool_results) if tool_results else 0}, message_batch={len(message_batch) if message_batch else 0}")
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

            # Prepare state with context included
            # Context from RunAgentInput is stored under _ag_ui_context key,
            # making it accessible via tool_context.state['_ag_ui_context']
            state_with_context = dict(input.state) if input.state else {}
            if input.context:
                state_with_context[CONTEXT_STATE_KEY] = [
                    {"description": ctx.description, "value": ctx.value}
                    for ctx in input.context
                ]

            # Ensure session exists and get backend session_id
            session, backend_session_id = await self._ensure_session_exists(
                app_name, user_id, input.thread_id, state_with_context
            )

            # this will always update the backend states with the frontend states
            # Recipe Demo Example: if there is a state "salt" in the ingredients state and in frontend user remove this salt state using UI from the ingredients list then our backend should also update these state changes as well to sync both the states
            await self._session_manager.update_session_state(backend_session_id, app_name, user_id, state_with_context)

            # Refresh session to get updated last_update_time after state update
            # This prevents "stale session" errors when using DatabaseSessionService
            # See: https://github.com/ag-ui-protocol/ag-ui/issues/957
            refreshed_session = await self._session_manager.get_session(backend_session_id, app_name, user_id)
            if refreshed_session:
                session = refreshed_session
            else:
                logger.warning(
                    f"Failed to refresh session {backend_session_id} after state update. "
                    "Continuing with potentially stale session."
                )

            # Retrieve stored invocation_id for HITL resumption
            # When resuming after HITL pause, we must use the SAME invocation_id
            # to restore SequentialAgent state (current_sub_agent position)
            stored_invocation_id: Optional[str] = None
            try:
                current_state = await self._session_manager.get_session_state(
                    backend_session_id, app_name, user_id
                )
                if current_state:
                    stored_invocation_id = current_state.get(INVOCATION_ID_STATE_KEY)
                    if stored_invocation_id:
                        logger.debug(
                            f"Retrieved stored invocation_id for resumption: {stored_invocation_id}"
                        )
            except Exception as e:
                logger.warning(f"Failed to retrieve stored invocation_id: {e}")

            # Convert messages
            unseen_messages = message_batch if message_batch is not None else await self._get_unseen_messages(input)

            active_tool_results: Optional[List[Dict]] = tool_results
            if active_tool_results is None and await self._is_tool_result_submission(input, unseen_messages):
                active_tool_results = await self._extract_tool_results(input, unseen_messages)

            if active_tool_results:
                tool_messages = [result["message"] for result in active_tool_results]
                message_ids = self._collect_message_ids(tool_messages)
                if message_ids:
                    self._session_manager.mark_messages_processed(app_name, input.thread_id, message_ids)
            elif unseen_messages:
                message_ids = self._collect_message_ids(unseen_messages)
                if message_ids:
                    self._session_manager.mark_messages_processed(app_name, input.thread_id, message_ids)

            # Convert user messages first (if any)
            # Note: We pass unseen_messages which is already set from message_batch or _get_unseen_messages
            # The original code had a bug: `if message_batch else None` would skip conversion when
            # message_batch was None but unseen_messages contained valid user messages
            user_message = await self._convert_latest_message(input, unseen_messages)

            # if there is a tool response submission by the user, add FunctionResponse to session first
            if active_tool_results and user_message:
                # We have BOTH tool results AND a user message
                # Add FunctionResponse as a separate event to the session, then send user message
                function_response_parts = []
                for tool_msg in active_tool_results:
                    tool_call_id = tool_msg['message'].tool_call_id
                    content = tool_msg['message'].content

                    # Debug: Log the actual tool message content we received
                    logger.debug(f"Received tool result for call {tool_call_id}: content='{content}', type={type(content)}")

                    # Parse content - try JSON first, fall back to plain string
                    try:
                        if content and content.strip():
                            # Try to parse as JSON first
                            try:
                                result = json.loads(content)
                            except json.JSONDecodeError:
                                # Not valid JSON - treat as plain string result
                                result = {"success": True, "result": content, "status": "completed"}
                                logger.debug(f"Tool result for {tool_call_id} is plain string, wrapped in result object")
                        else:
                            # Handle empty content as a success with empty result
                            result = {"success": True, "result": None, "status": "completed"}
                            logger.warning(f"Empty tool result content for tool call {tool_call_id}, using empty success result")
                    except Exception as e:
                        # Handle any other error
                        result = {"success": True, "result": str(content) if content else None, "status": "completed"}
                        logger.warning(f"Error processing tool result for {tool_call_id}: {e}, using string fallback")

                    updated_function_response_part = types.Part(
                        function_response=types.FunctionResponse(
                            id=tool_call_id,
                            name=tool_msg["tool_name"],
                            response=result,
                        )
                    )
                    function_response_parts.append(updated_function_response_part)

                # Add FunctionResponse as separate event to session
                # (session was already obtained from _ensure_session_exists above)

                from google.adk.sessions.session import Event
                import time

                function_response_content = types.Content(parts=function_response_parts, role='user')
                # Use stored invocation_id for HITL resumption to restore SequentialAgent state
                resume_invocation_id = stored_invocation_id or input.run_id
                function_response_event = Event(
                    timestamp=time.time(),
                    author='user',
                    content=function_response_content,
                    invocation_id=resume_invocation_id,
                )
                logger.debug(f"Creating FunctionResponse event with invocation_id={resume_invocation_id}")

                await self._session_manager._session_service.append_event(session, function_response_event)

                # Mark user messages from message_batch as processed
                if message_batch:
                    user_message_ids = self._collect_message_ids(message_batch)
                    if user_message_ids:
                        self._session_manager.mark_messages_processed(app_name, input.thread_id, user_message_ids)

                # Use ONLY the user message as new_message
                new_message = user_message

            elif active_tool_results:
                # Tool results WITHOUT user message - send FunctionResponse alone
                function_response_parts = []
                for tool_msg in active_tool_results:
                    tool_call_id = tool_msg['message'].tool_call_id
                    content = tool_msg['message'].content

                    logger.debug(f"Received tool result for call {tool_call_id}: content='{content}', type={type(content)}")

                    # Parse content - try JSON first, fall back to plain string
                    try:
                        if content and content.strip():
                            # Try to parse as JSON first
                            try:
                                result = json.loads(content)
                            except json.JSONDecodeError:
                                # Not valid JSON - treat as plain string result
                                result = {"success": True, "result": content, "status": "completed"}
                                logger.debug(f"Tool result for {tool_call_id} is plain string, wrapped in result object")
                        else:
                            result = {"success": True, "result": None, "status": "completed"}
                            logger.warning(f"Empty tool result content for tool call {tool_call_id}, using empty success result")
                    except Exception as e:
                        # Handle any other error
                        result = {"success": True, "result": str(content) if content else None, "status": "completed"}
                        logger.warning(f"Error processing tool result for {tool_call_id}: {e}, using string fallback")

                    updated_function_response_part = types.Part(
                        function_response=types.FunctionResponse(
                            id=tool_call_id,
                            name=tool_msg["tool_name"],
                            response=result,
                        )
                    )
                    function_response_parts.append(updated_function_response_part)

                # Persist FunctionResponse event so DatabaseSessionService has invocation_id
                from google.adk.sessions.session import Event
                import time

                function_response_content = types.Content(parts=function_response_parts, role='user')
                # Use stored invocation_id for HITL resumption to restore SequentialAgent state
                resume_invocation_id = stored_invocation_id or input.run_id
                function_response_event = Event(
                    timestamp=time.time(),
                    author='user',
                    content=function_response_content,
                    invocation_id=resume_invocation_id,
                )
                logger.debug(f"Creating FunctionResponse event with invocation_id={resume_invocation_id}")

                await self._session_manager._session_service.append_event(session, function_response_event)

                new_message = function_response_content
            else:
                # No tool results, just use the user message
                # If user_message is None (e.g., unseen_messages was empty because all were
                # already processed), fall back to extracting the latest user message from input.messages
                if user_message is None and input.messages:
                    user_message = await self._convert_latest_message(input, input.messages)
                new_message = user_message

            # Create a single shared set for tracking tool call IDs emitted by ClientProxyTool.
            # All ClientProxyToolsets in this run reference this set so the EventTranslator
            # sees IDs added by any proxy tool during execution (the set is mutated in-place).
            client_emitted_ids: set[str] = set()
            for toolset in client_proxy_toolsets:
                toolset._emitted_tool_call_ids = client_emitted_ids

            # Collect client-side tool names from proxy toolsets
            client_tool_names: set[str] = set()
            for toolset in client_proxy_toolsets:
                for tool in toolset.ag_ui_tools:
                    client_tool_names.add(tool.name)

            # Create event translator with predictive state configuration
            event_translator = EventTranslator(
                predict_state=self._predict_state,
                client_emitted_tool_call_ids=client_emitted_ids,
                client_tool_names=client_tool_names,
                is_resumable=self._is_adk_resumable(),
            )

            # Share the translator's emitted IDs set with proxy toolsets so
            # ClientProxyTool can skip emission when the translator already handled it.
            for toolset in client_proxy_toolsets:
                toolset._translator_emitted_tool_call_ids = event_translator.emitted_tool_call_ids

            try:
                # Session was already obtained from _ensure_session_exists above
                # Check session events (ADK stores conversation in events)
                events = getattr(session, 'events', [])
                logger.info(f"[SESSION_DEBUG] Session has {len(events)} events")

                # If sending FunctionResponse, look for the original FunctionCall in session
                if active_tool_results:
                    tool_call_id = active_tool_results[0]['message'].tool_call_id
                    logger.info(f"[SESSION_DEBUG] Looking for FunctionCall with id={tool_call_id}")

                    # Log all function calls in session for debugging
                    all_function_call_ids = []
                    found_call = False
                    for evt_idx, evt in enumerate(events):
                        evt_content = getattr(evt, 'content', None)
                        evt_author = getattr(evt, 'author', 'unknown')
                        evt_inv_id = getattr(evt, 'invocation_id', 'none')
                        if evt_content:
                            evt_parts = getattr(evt_content, 'parts', [])
                            for part in evt_parts:
                                if hasattr(part, 'function_call') and part.function_call:
                                    fc = part.function_call
                                    fc_id = getattr(fc, 'id', 'no_id')
                                    fc_name = getattr(fc, 'name', 'no_name')
                                    all_function_call_ids.append(f"{fc_name}:{fc_id}")
                                    if fc_id == tool_call_id:
                                        found_call = True
                                        logger.info(f"[SESSION_DEBUG] FOUND matching FunctionCall at event[{evt_idx}], author={evt_author}, invocation_id={evt_inv_id}")
                        if found_call:
                            break

                    logger.info(f"[SESSION_DEBUG] All FunctionCalls in session: {all_function_call_ids}")
                    if not found_call:
                        logger.warning(f"[SESSION_DEBUG] FunctionCall NOT FOUND for id={tool_call_id}! ADK will fail with 'No function call event found'")
            except Exception as e:
                logger.error(f"[SESSION_DEBUG] Error checking session events: {e}")

            # Run ADK agent
            is_long_running_tool = False
            invocation_id_stored = False  # Track if we've stored the invocation_id this run
            run_kwargs = {
                "user_id": user_id,
                "session_id": backend_session_id,  # Use backend session_id, not thread_id
                "new_message": new_message,
                "run_config": run_config
            }

            # Pass stored invocation_id to run_async for HITL resumption
            # This enables SequentialAgent to restore its current_sub_agent position
            # Only pass invocation_id if the app is resumable (has ResumabilityConfig)
            if stored_invocation_id and self._is_adk_resumable():
                run_kwargs["invocation_id"] = stored_invocation_id
                logger.info(f"[RUN_ASYNC] HITL resumption with invocation_id: {stored_invocation_id}")
            else:
                logger.info(f"[RUN_ASYNC] New run (no invocation_id, resumable={self._is_adk_resumable()})")

            logger.info(f"[RUN_ASYNC] Calling runner.run_async with session_id={backend_session_id}, has_message={new_message is not None}")

            async for adk_event in runner.run_async(**run_kwargs):
                event_invocation_id = getattr(adk_event, 'invocation_id', None)
                event_author = getattr(adk_event, 'author', 'unknown')
                event_partial = getattr(adk_event, 'partial', False)
                event_turn_complete = getattr(adk_event, 'turn_complete', None)

                # Log which agent is producing events
                content_preview = ""
                if adk_event.content and hasattr(adk_event.content, 'parts') and adk_event.content.parts:
                    for part in adk_event.content.parts:
                        if hasattr(part, 'text') and part.text:
                            content_preview = part.text[:100].replace('\n', ' ')
                            break
                        elif hasattr(part, 'function_call') and part.function_call:
                            content_preview = f"[FunctionCall: {part.function_call.name}]"
                            break
                logger.info(f"[ADK_EVENT] author={event_author}, partial={event_partial}, turn_complete={event_turn_complete}, content={content_preview[:80]}...")

                # Store invocation_id for HITL resumption on first event with valid ID
                # This enables SequentialAgent to restore its current_sub_agent position
                # Only store if the app is resumable (has ResumabilityConfig)
                if (event_invocation_id and not invocation_id_stored and
                        not stored_invocation_id and self._is_adk_resumable()):
                    try:
                        await self._session_manager.update_session_state(
                            backend_session_id, app_name, user_id,
                            {INVOCATION_ID_STATE_KEY: event_invocation_id}
                        )
                        invocation_id_stored = True
                        logger.debug(
                            f"Stored invocation_id for HITL resumption: {event_invocation_id}"
                        )
                    except Exception as e:
                        logger.warning(f"Failed to store invocation_id: {e}")

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

                # Check if event has function responses (e.g., backend tool results)
                # This is needed for skip_summarization scenarios where there's no text
                # content but we still need to emit ToolCallResultEvent (GitHub #765)
                has_function_responses = (
                    hasattr(adk_event, 'get_function_responses') and
                    adk_event.get_function_responses()
                )

                # Process as streaming if it's a chunk OR if it has content OR has function responses,
                # but only when there is no LRO function call present (LRO takes precedence)
                # Note: We don't exclude based on finish_reason - final responses with content
                # (e.g., after backend tool completion) must still be translated.
                if (not has_lro_function_call) and (is_streaming_chunk or has_content or has_function_responses):
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

                    # CRITICAL FIX (GitHub #906): Process text content BEFORE LRO tool calls
                    # In non-streaming mode, text and tool calls may arrive in the same event.
                    # We must emit TEXT_MESSAGE events before TOOL_CALL events.
                    if has_content:
                        async for ag_ui_event in event_translator.translate_text_only(
                            adk_event, input.thread_id, input.run_id
                        ):
                            await event_queue.put(ag_ui_event)
                            logger.debug(f"Event queued (LRO text): {type(ag_ui_event).__name__} (thread {input.thread_id})")

                    # Ensure any active streaming text message is closed BEFORE tool calls
                    async for end_event in event_translator.force_close_streaming_message():
                        await event_queue.put(end_event)
                        logger.debug(f"Event queued (forced close): {type(end_event).__name__} (thread {input.thread_id}, queue size after: {event_queue.qsize()})")

                    # Set flag based on LRO detection directly — the translator may
                    # skip client tools to avoid duplicate emission, but we still
                    # need to know an LRO pause happened for invocation_id management.
                    if has_lro_function_call:
                        is_long_running_tool = True

                    async for ag_ui_event in event_translator.translate_lro_function_calls(
                        adk_event
                    ):
                        await event_queue.put(ag_ui_event)
                        if ag_ui_event.type == EventType.TOOL_CALL_END:
                            is_long_running_tool = True
                        logger.debug(f"Event queued: {type(ag_ui_event).__name__} (thread {input.thread_id}, queue size after: {event_queue.qsize()})")
                    # Hard stop the execution if we find any long running tool
                    # AND the agent is NOT using ADK's native resumability.
                    # With ResumabilityConfig, ADK handles the pause/resume flow
                    # natively — we don't need to stop the loop early.
                    if is_long_running_tool and not self._is_adk_resumable():
                        import warnings
                        warnings.warn(
                            "Non-resumable HITL (fire-and-forget) is deprecated and will be removed "
                            "in a future version. Use ADKAgent.from_app() with "
                            "ResumabilityConfig(is_resumable=True) for human-in-the-loop workflows. "
                            "See USAGE.md for migration instructions.",
                            DeprecationWarning,
                            stacklevel=2,
                        )
                        # With PROGRESSIVE_SSE_STREAMING (ADK >= 1.22.0), the
                        # FunctionCall may arrive as a partial event that ADK
                        # hasn't persisted to the session.  We must persist it
                        # so the next run can match the FunctionResponse.
                        if getattr(adk_event, 'partial', False) and adk_event.content:
                            from google.adk.sessions.session import Event as ADKSessionEvent
                            import time as _time_mod
                            fc_event = ADKSessionEvent(
                                timestamp=_time_mod.time(),
                                author=getattr(adk_event, 'author', 'assistant'),
                                content=adk_event.content,
                                invocation_id=getattr(adk_event, 'invocation_id', None) or input.run_id,
                            )
                            try:
                                await self._session_manager._session_service.append_event(session, fc_event)
                                logger.info(
                                    f"Persisted FunctionCall event to session for LRO early return "
                                    f"(partial event, thread={input.thread_id})"
                                )
                            except Exception as e:
                                logger.warning(f"Failed to persist FunctionCall event: {e}")
                        return

            # Force close any streaming messages
            async for ag_ui_event in event_translator.force_close_streaming_message():
                await event_queue.put(ag_ui_event)

            # Clear stored invocation_id after a completed run so subsequent
            # new runs don't erroneously attempt HITL resumption with a stale ID.
            # Only clear when NOT paused on an LRO tool — if we're pausing for
            # HITL, the invocation_id is needed for the resume.
            if self._is_adk_resumable() and (stored_invocation_id or invocation_id_stored) and not is_long_running_tool:
                try:
                    await self._session_manager.update_session_state(
                        backend_session_id, app_name, user_id,
                        {INVOCATION_ID_STATE_KEY: None}
                    )
                    logger.debug(
                        f"Cleared stored invocation_id after completed run: {stored_invocation_id}"
                    )
                except Exception as e:
                    logger.warning(f"Failed to clear stored invocation_id: {e}")

            # moving states snapshot events after the text event clousure to avoid this error https://github.com/Contextable/ag-ui/issues/28
            final_state = await self._session_manager.get_session_state(backend_session_id, app_name, user_id)

            # Merge accumulated predictive state from all ClientProxyToolset instances
            # This ensures values set during HITL tool calls survive the final STATE_SNAPSHOT
            accumulated_predict_state = {}
            for toolset in client_proxy_toolsets:
                accumulated_predict_state.update(toolset.get_accumulated_predict_state())

            if accumulated_predict_state:
                logger.debug(f"Merging accumulated predict_state into final state: {list(accumulated_predict_state.keys())}")
                # Merge: accumulated predict_state values take priority over session state
                # (the session state may use different keys like 'approved_plan' vs 'plan')
                if final_state:
                    merged_state = {**final_state, **accumulated_predict_state}
                else:
                    merged_state = accumulated_predict_state
                ag_ui_event = event_translator._create_state_snapshot_event(merged_state)
                await event_queue.put(ag_ui_event)
            elif final_state:
                ag_ui_event = event_translator._create_state_snapshot_event(final_state)
                await event_queue.put(ag_ui_event)

            # Emit MESSAGES_SNAPSHOT if configured
            if self._emit_messages_snapshot:
                try:
                    # Refresh session to get latest events
                    session = await self._session_manager.get_session(backend_session_id, app_name, user_id)
                    if session and hasattr(session, 'events') and session.events:
                        messages = adk_events_to_messages(session.events)
                        if messages:
                            messages_snapshot_event = MessagesSnapshotEvent(
                                type=EventType.MESSAGES_SNAPSHOT,
                                messages=messages
                            )
                            await event_queue.put(messages_snapshot_event)
                            logger.debug(f"Emitted MESSAGES_SNAPSHOT with {len(messages)} messages for thread {input.thread_id}")
                except Exception as snapshot_error:
                    logger.warning(f"Failed to emit MESSAGES_SNAPSHOT for thread {input.thread_id}: {snapshot_error}")

            # Emit any deferred confirm_changes events LAST, right before completion
            # This ensures the frontend sees confirm_changes as the last tool call event,
            # keeping the confirmation dialog in "executing" status with buttons enabled
            for deferred_event in event_translator.get_and_clear_deferred_confirm_events():
                logger.debug(f"Emitting deferred confirm_changes event: {type(deferred_event).__name__}")
                await event_queue.put(deferred_event)

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
