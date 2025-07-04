# src/adk_agent.py

"""Main ADKAgent implementation for bridging AG-UI Protocol with Google ADK."""

import sys
from pathlib import Path
from typing import Optional, Dict, Callable, Any, AsyncGenerator
import asyncio
import logging
import time
from datetime import datetime

# Add python-sdk to path if not already there
python_sdk_path = Path(__file__).parent.parent.parent.parent.parent / "python-sdk"
if str(python_sdk_path) not in sys.path:
    sys.path.insert(0, str(python_sdk_path))

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
from google.adk.sessions import BaseSessionService, InMemorySessionService
from google.adk.artifacts import BaseArtifactService, InMemoryArtifactService
from google.adk.memory import BaseMemoryService, InMemoryMemoryService
from google.adk.auth.credential_service.base_credential_service import BaseCredentialService
from google.genai import types

from agent_registry import AgentRegistry
from event_translator import EventTranslator
from session_manager import SessionLifecycleManager

logger = logging.getLogger(__name__)


class ADKAgent:
    """Middleware to bridge AG-UI Protocol with Google ADK agents.
    
    This agent translates between the AG-UI protocol events and Google ADK events,
    managing sessions, state, and the lifecycle of ADK agents.
    """
    
    def __init__(
        self,
        # User identification
        user_id: Optional[str] = None,
        user_id_extractor: Optional[Callable[[RunAgentInput], str]] = None,
        
        # ADK Services
        session_service: Optional[BaseSessionService] = None,
        artifact_service: Optional[BaseArtifactService] = None,
        memory_service: Optional[BaseMemoryService] = None,
        credential_service: Optional[BaseCredentialService] = None,
        
        # Session management
        session_timeout_seconds: int = 3600,
        cleanup_interval_seconds: int = 300,
        max_sessions_per_user: Optional[int] = None,
        auto_cleanup: bool = True,
        
        # Configuration
        run_config_factory: Optional[Callable[[RunAgentInput], ADKRunConfig]] = None,
        use_in_memory_services: bool = True
    ):
        """Initialize the ADKAgent.
        
        Args:
            user_id: Static user ID for all requests
            user_id_extractor: Function to extract user ID dynamically from input
            session_service: Session storage service
            artifact_service: File/artifact storage service
            memory_service: Conversation memory and search service
            credential_service: Authentication credential storage
            session_timeout_seconds: Session timeout in seconds (default: 1 hour)
            cleanup_interval_seconds: Cleanup interval in seconds (default: 5 minutes)
            max_sessions_per_user: Maximum sessions per user (default: unlimited)
            auto_cleanup: Enable automatic session cleanup
            run_config_factory: Function to create RunConfig per request
            use_in_memory_services: Use in-memory implementations for unspecified services
        """
        if user_id and user_id_extractor:
            raise ValueError("Cannot specify both 'user_id' and 'user_id_extractor'")
        
        self._static_user_id = user_id
        self._user_id_extractor = user_id_extractor
        self._run_config_factory = run_config_factory or self._default_run_config
        
        # Initialize services with intelligent defaults
        if use_in_memory_services:
            self._session_service = session_service or InMemorySessionService()
            self._artifact_service = artifact_service or InMemoryArtifactService()
            self._memory_service = memory_service or InMemoryMemoryService()
            self._credential_service = credential_service  # or InMemoryCredentialService()
        else:
            # Require explicit services for production
            self._session_service = session_service
            self._artifact_service = artifact_service
            self._memory_service = memory_service
            self._credential_service = credential_service
            
            if not self._session_service:
                raise ValueError("session_service is required when use_in_memory_services=False")
        
        # Runner cache: key is "{agent_id}:{user_id}"
        self._runners: Dict[str, Runner] = {}
        
        # Session lifecycle management
        self._session_manager = SessionLifecycleManager(
            session_timeout_seconds=session_timeout_seconds,
            cleanup_interval_seconds=cleanup_interval_seconds,
            max_sessions_per_user=max_sessions_per_user
        )
        
        # Event translator
        self._event_translator = EventTranslator()
        
        # Start cleanup task if enabled
        self._cleanup_task: Optional[asyncio.Task] = None
        if auto_cleanup:
            self._start_cleanup_task()
    
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
        # Check common context patterns
        for ctx in input.context:
            if ctx.description.lower() in ["user_id", "user", "userid", "username"]:
                return ctx.value
        
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
    
    def _extract_agent_id(self, input: RunAgentInput) -> str:
        """Extract agent ID from RunAgentInput.
        
        This could come from various sources depending on the AG-UI implementation.
        For now, we'll check common locations.
        """
        # Check context for agent_id
        for ctx in input.context:
            if ctx.description.lower() in ["agent_id", "agent", "agentid"]:
                return ctx.value
        
        # Check state
        if hasattr(input.state, 'get') and input.state.get("agent_id"):
            return input.state["agent_id"]
        
        # Check forwarded props
        if input.forwarded_props and "agent_id" in input.forwarded_props:
            return input.forwarded_props["agent_id"]
        
        # Default to a generic agent ID
        return "default"
    
    def _get_or_create_runner(self, agent_id: str, adk_agent: ADKBaseAgent, user_id: str) -> Runner:
        """Get existing runner or create a new one."""
        runner_key = f"{agent_id}:{user_id}"
        
        if runner_key not in self._runners:
            self._runners[runner_key] = Runner(
                app_name=agent_id,  # Use AG-UI agent_id as app_name
                agent=adk_agent,
                session_service=self._session_service,
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
            agent_id = self._extract_agent_id(input)
            user_id = self._get_user_id(input)
            session_key = f"{agent_id}:{user_id}:{input.thread_id}"
            
            # Track session activity
            self._session_manager.track_activity(session_key, agent_id, user_id, input.thread_id)
            
            # Check session limits
            if self._session_manager.should_create_new_session(user_id):
                await self._cleanup_oldest_session(user_id)
            
            # Get the ADK agent from registry
            registry = AgentRegistry.get_instance()
            adk_agent = registry.get_agent(agent_id)
            
            # Get or create runner
            runner = self._get_or_create_runner(agent_id, adk_agent, user_id)
            
            # Create RunConfig
            run_config = self._run_config_factory(input)
            
            # Convert messages to ADK format
            new_message = await self._convert_latest_message(input)
            
            # Run the ADK agent
            async for adk_event in runner.run_async(
                user_id=user_id,
                session_id=input.thread_id,  # Use thread_id as session_id
                new_message=new_message,
                run_config=run_config
            ):
                # Translate ADK events to AG-UI events
                async for ag_ui_event in self._event_translator.translate(
                    adk_event, 
                    input.thread_id,
                    input.run_id
                ):
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
    
    def _start_cleanup_task(self):
        """Start the background cleanup task."""
        async def cleanup_loop():
            while True:
                try:
                    await self._cleanup_expired_sessions()
                    await asyncio.sleep(self._session_manager._cleanup_interval)
                except Exception as e:
                    logger.error(f"Error in cleanup task: {e}")
                    await asyncio.sleep(self._session_manager._cleanup_interval)
        
        self._cleanup_task = asyncio.create_task(cleanup_loop())
    
    async def _cleanup_expired_sessions(self):
        """Clean up expired sessions."""
        expired_sessions = self._session_manager.get_expired_sessions()
        
        for session_info in expired_sessions:
            try:
                agent_id = session_info["agent_id"]
                user_id = session_info["user_id"]
                session_id = session_info["session_id"]
                
                # Clean up Runner if no more sessions for this user
                runner_key = f"{agent_id}:{user_id}"
                if runner_key in self._runners:
                    # Check if this user has any other active sessions
                    has_other_sessions = any(
                        info["user_id"] == user_id and 
                        info["session_id"] != session_id
                        for info in self._session_manager._sessions.values()
                    )
                    
                    if not has_other_sessions:
                        await self._runners[runner_key].close()
                        del self._runners[runner_key]
                
                # Delete session from service
                await self._session_service.delete_session(
                    app_name=agent_id,
                    user_id=user_id,
                    session_id=session_id
                )
                
                # Remove from session manager
                self._session_manager.remove_session(f"{agent_id}:{user_id}:{session_id}")
                
                logger.info(f"Cleaned up expired session: {session_id} for user: {user_id}")
                
            except Exception as e:
                logger.error(f"Error cleaning up session: {e}")
    
    async def _cleanup_oldest_session(self, user_id: str):
        """Clean up the oldest session for a user when limit is reached."""
        oldest_session = self._session_manager.get_oldest_session_for_user(user_id)
        if oldest_session:
            await self._cleanup_expired_sessions()  # This will clean up the marked session
    
    async def close(self):
        """Clean up resources."""
        # Cancel cleanup task
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
        
        # Close all runners
        for runner in self._runners.values():
            await runner.close()
        
        self._runners.clear()