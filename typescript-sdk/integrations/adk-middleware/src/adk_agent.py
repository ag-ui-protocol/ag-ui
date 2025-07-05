# src/adk_agent.py

"""Main ADKAgent implementation for bridging AG-UI Protocol with Google ADK."""

from typing import Optional, Dict, Callable, Any, AsyncGenerator
import time
from datetime import datetime

from ag_ui.core import (
    RunAgentInput, BaseEvent, EventType,
    RunStartedEvent, RunFinishedEvent, RunErrorEvent,
    TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent,
    StateSnapshotEvent, StateDeltaEvent,
    Context
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

from agent_registry import AgentRegistry
from event_translator import EventTranslator
from session_manager import SessionLifecycleManager
from logging_config import get_component_logger

logger = get_component_logger('adk_agent')


class ADKAgent:
    """Middleware to bridge AG-UI Protocol with Google ADK agents.
    
    This agent translates between the AG-UI protocol events and Google ADK events,
    managing sessions, state, and the lifecycle of ADK agents.
    """
    
    def __init__(
        self,
        app_name: str,
        # User identification
        user_id: Optional[str] = None,
        user_id_extractor: Optional[Callable[[RunAgentInput], str]] = None,
        
        # ADK Services (session service now encapsulated in session manager)
        artifact_service: Optional[BaseArtifactService] = None,
        memory_service: Optional[BaseMemoryService] = None,
        credential_service: Optional[BaseCredentialService] = None,
        
        # Configuration
        run_config_factory: Optional[Callable[[RunAgentInput], ADKRunConfig]] = None,
        use_in_memory_services: bool = True
    ):
        """Initialize the ADKAgent.
        
        Args:
            app_name: Application name (used as app_name in ADK Runner)
            user_id: Static user ID for all requests
            user_id_extractor: Function to extract user ID dynamically from input
            artifact_service: File/artifact storage service
            memory_service: Conversation memory and search service
            credential_service: Authentication credential storage
            run_config_factory: Function to create RunConfig per request
            use_in_memory_services: Use in-memory implementations for unspecified services
        """
        if user_id and user_id_extractor:
            raise ValueError("Cannot specify both 'user_id' and 'user_id_extractor'")
        
        self._app_name = app_name
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
            
        self._session_manager = SessionLifecycleManager.get_instance(
            session_service=session_service,
            session_timeout_seconds=1200,  # 20 minutes default
            cleanup_interval_seconds=300,  # 5 minutes default
            max_sessions_per_user=None,    # No limit by default
            auto_cleanup=True              # Enable by default
        )
        
        # Event translator will be created per-session for thread safety
        
        # Cleanup is managed by the session manager
        # Will start when first async operation runs
    
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
        # Check state for user_id
        if hasattr(input.state, 'get') and input.state.get("user_id"):
            return input.state["user_id"]
        
        # Use thread_id as a last resort (assumes thread per user)
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
    
    def _get_or_create_runner(self, agent_id: str, adk_agent: ADKBaseAgent, user_id: str) -> Runner:
        """Get existing runner or create a new one."""
        runner_key = f"{agent_id}:{user_id}"
        
        if runner_key not in self._runners:
            self._runners[runner_key] = Runner(
                app_name=self._app_name,  # Use the app_name from constructor
                agent=adk_agent,
                session_service=self._session_manager._session_service,
                artifact_service=self._artifact_service,
                memory_service=self._memory_service,
                credential_service=self._credential_service
            )
        
        return self._runners[runner_key]
    
    async def run(self, input: RunAgentInput) -> AsyncGenerator[BaseEvent, None]:
        """Run the ADK agent and translate events to AG-UI protocol.
        
        Args:
            input: The AG-UI run input
            
        Yields:
            AG-UI protocol events
        """
        try:
            # Emit RUN_STARTED first
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input.thread_id,
                run_id=input.run_id
            )
            
            # Extract necessary information
            agent_id = self._get_agent_id()
            user_id = self._get_user_id(input)
            session_key = f"{agent_id}:{user_id}:{input.thread_id}"
            
            # Track session activity
            self._session_manager.track_activity(session_key, self._app_name, user_id, input.thread_id)
            
            # Session management is handled by SessionLifecycleManager
            
            # Get the ADK agent from registry
            registry = AgentRegistry.get_instance()
            adk_agent = registry.get_agent(agent_id)
            
            # Get or create runner
            runner = self._get_or_create_runner(agent_id, adk_agent, user_id)
            
            # Create RunConfig
            run_config = self._run_config_factory(input)
            
            # Ensure session exists
            await self._ensure_session_exists(self._app_name, user_id, input.thread_id, input.state)
            
            # Create a fresh event translator for this session (thread-safe)
            event_translator = EventTranslator()
            
            # Convert messages to ADK format
            new_message = await self._convert_latest_message(input)
            
            # Run the ADK agent
            async for adk_event in runner.run_async(
                user_id=user_id,
                session_id=input.thread_id,  # Use thread_id as session_id
                new_message=new_message,
                run_config=run_config
            ):
                # Translate ADK events to AG-UI events using session-specific translator
                async for ag_ui_event in event_translator.translate(
                    adk_event, 
                    input.thread_id,
                    input.run_id
                ):
                    yield ag_ui_event
            
            # Force-close any unterminated streaming message before finishing
            async for ag_ui_event in event_translator.force_close_streaming_message():
                yield ag_ui_event
            
            # Emit RUN_FINISHED
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input.thread_id,
                run_id=input.run_id
            )
            
        except Exception as e:
            logger.error(f"Error in ADKAgent.run: {e}", exc_info=True)
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=str(e),
                code="ADK_ERROR"
            )
    
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
    
    
    async def close(self):
        """Clean up resources."""
        # Stop session manager cleanup task
        self._session_manager.stop_cleanup_task()
        
        # Close all runners
        for runner in self._runners.values():
            await runner.close()
        
        self._runners.clear()