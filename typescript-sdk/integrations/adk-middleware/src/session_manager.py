# src/session_manager.py

"""Session lifecycle management for ADK middleware."""

from typing import Dict, Optional, List, Any
import time
import logging
import asyncio
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class SessionInfo:
    """Information about an active session."""
    session_key: str
    app_name: str
    user_id: str
    session_id: str
    last_activity: float
    created_at: float
    adk_session: Any = field(default=None)  # Store the actual ADK session object


class SessionLifecycleManager:
    """Singleton session lifecycle manager.
    
    Manages all ADK sessions globally, including creation, deletion,
    timeout monitoring, and cleanup. Encapsulates the session service.
    """
    
    _instance = None
    _initialized = False
    
    def __new__(cls, session_service=None, **kwargs):
        """Ensure singleton instance."""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    def __init__(
        self,
        session_service=None,
        session_timeout_seconds: int = 1200,  # 20 minutes default
        cleanup_interval_seconds: int = 300,  # 5 minutes
        max_sessions_per_user: Optional[int] = None,
        auto_cleanup: bool = True
    ):
        """Initialize the session lifecycle manager (singleton).
        
        Args:
            session_service: ADK session service (required on first initialization)
            session_timeout_seconds: Time before a session is considered expired
            cleanup_interval_seconds: Interval between cleanup cycles
            max_sessions_per_user: Maximum concurrent sessions per user (None = unlimited)
            auto_cleanup: Enable automatic session cleanup task
        """
        # Only initialize once
        if self._initialized:
            return
            
        if session_service is None:
            from google.adk.sessions import InMemorySessionService
            session_service = InMemorySessionService()
            
        self._session_service = session_service
        self._session_timeout = session_timeout_seconds
        self._cleanup_interval = cleanup_interval_seconds
        self._max_sessions_per_user = max_sessions_per_user
        self._auto_cleanup = auto_cleanup
        
        # Track sessions: session_key -> SessionInfo
        self._sessions: Dict[str, SessionInfo] = {}
        
        # Track user session counts for quick lookup
        self._user_session_counts: Dict[str, int] = {}
        
        # Cleanup task management
        self._cleanup_task: Optional[asyncio.Task] = None
        self._cleanup_started = False
        
        self._initialized = True
        
        logger.info(
            f"Initialized SessionLifecycleManager singleton - "
            f"timeout: {session_timeout_seconds}s, "
            f"cleanup interval: {cleanup_interval_seconds}s, "
            f"max per user: {max_sessions_per_user or 'unlimited'}, "
            f"auto cleanup: {auto_cleanup}"
        )
    
    @classmethod
    def get_instance(cls, **kwargs):
        """Get the singleton instance."""
        return cls(**kwargs)
    
    @classmethod
    def reset_instance(cls):
        """Reset singleton for testing purposes."""
        if cls._instance is not None:
            instance = cls._instance
            if hasattr(instance, '_cleanup_task') and instance._cleanup_task:
                instance._cleanup_task.cancel()
        cls._instance = None
        cls._initialized = False
    
    @property
    def auto_cleanup_enabled(self) -> bool:
        """Check if automatic cleanup is enabled."""
        return self._auto_cleanup
    
    async def get_or_create_session(
        self,
        session_id: str,
        app_name: str,
        user_id: str,
        initial_state: Optional[Dict[str, Any]] = None
    ) -> Any:
        """Get existing session or create new one via session service.
        
        Args:
            session_id: The session identifier
            app_name: The application name identifier
            user_id: The user identifier
            initial_state: Initial state for new sessions
            
        Returns:
            The ADK session object
        """
        session_key = f"{app_name}:{session_id}"
        
        # Check if we already have this session
        if session_key in self._sessions:
            session_info = self._sessions[session_key]
            session_info.last_activity = time.time()
            logger.debug(f"Using existing session: {session_key}")
            return session_info.adk_session
        
        # Try to get existing session from ADK
        try:
            adk_session = await self._session_service.get_session(
                session_id=session_id,
                app_name=app_name,
                user_id=user_id
            )
            if adk_session:
                logger.info(f"Retrieved existing ADK session: {session_key}")
            else:
                # Create new session
                adk_session = await self._session_service.create_session(
                    session_id=session_id,
                    user_id=user_id,
                    app_name=app_name,
                    state=initial_state or {}
                )
                logger.info(f"Created new ADK session: {session_key}")
            
            # Track the session
            self._track_session(session_key, app_name, user_id, session_id, adk_session)
            return adk_session
            
        except Exception as e:
            logger.error(f"Failed to get/create session {session_key}: {e}")
            raise
    
    def _track_session(
        self,
        session_key: str,
        app_name: str,
        user_id: str,
        session_id: str,
        adk_session: Any
    ):
        """Track a session in our internal management."""
        current_time = time.time()
        
        # Remove old session if it exists
        if session_key in self._sessions:
            old_info = self._sessions[session_key]
            self._user_session_counts[old_info.user_id] -= 1
            if self._user_session_counts[old_info.user_id] <= 0:
                del self._user_session_counts[old_info.user_id]
        
        # Handle session limits per user
        if self._max_sessions_per_user is not None:
            current_count = self._user_session_counts.get(user_id, 0)
            if current_count >= self._max_sessions_per_user:
                # Remove oldest session for this user
                self._remove_oldest_session_for_user(user_id)
        
        # Track new session
        session_info = SessionInfo(
            session_key=session_key,
            app_name=app_name,
            user_id=user_id,
            session_id=session_id,
            last_activity=current_time,
            created_at=current_time,
            adk_session=adk_session
        )
        
        self._sessions[session_key] = session_info
        self._user_session_counts[user_id] = self._user_session_counts.get(user_id, 0) + 1
        
        # Start cleanup task if needed
        self._start_cleanup_task_if_needed()
        
        logger.debug(f"Tracking session: {session_key} for user: {user_id}")
    
    def track_activity(
        self, 
        session_key: str,
        app_name: str,
        user_id: str,
        session_id: str
    ) -> None:
        """Track activity for an existing session (update last_activity timestamp)."""
        if session_key in self._sessions:
            self._sessions[session_key].last_activity = time.time()
            logger.debug(f"Updated activity for session: {session_key}")
        else:
            # Session not tracked yet, create basic tracking
            current_time = time.time()
            session_info = SessionInfo(
                session_key=session_key,
                app_name=app_name,
                user_id=user_id,
                session_id=session_id,
                last_activity=current_time,
                created_at=current_time
            )
            self._sessions[session_key] = session_info
            self._user_session_counts[user_id] = self._user_session_counts.get(user_id, 0) + 1
            self._start_cleanup_task_if_needed()
            logger.debug(f"Started tracking new session: {session_key}")
    
    def get_expired_sessions(self) -> List[Dict[str, Any]]:
        """Get list of expired sessions as dictionaries."""
        current_time = time.time()
        expired = []
        
        for session_key, session_info in self._sessions.items():
            age = current_time - session_info.last_activity
            if age > self._session_timeout:
                expired.append({
                    "session_key": session_key,
                    "app_name": session_info.app_name,
                    "user_id": session_info.user_id,
                    "session_id": session_info.session_id,
                    "age": age,
                    "last_activity": session_info.last_activity
                })
        
        return expired
    
    async def remove_session(self, session_key: str) -> bool:
        """Remove a session from tracking and delete from ADK."""
        if session_key not in self._sessions:
            return False
        
        session_info = self._sessions[session_key]
        
        # Delete from ADK session service if we have the session object
        if session_info.adk_session:
            try:
                await self._session_service.delete_session(
                    session_id=session_info.session_id,
                    app_name=session_info.app_name,
                    user_id=session_info.user_id
                )
                logger.info(f"Deleted ADK session: {session_key}")
            except Exception as e:
                logger.error(f"Failed to delete ADK session {session_key}: {e}")
        
        # Remove from our tracking
        del self._sessions[session_key]
        
        # Update user session count
        user_id = session_info.user_id
        if user_id in self._user_session_counts:
            self._user_session_counts[user_id] -= 1
            if self._user_session_counts[user_id] <= 0:
                del self._user_session_counts[user_id]
        
        logger.debug(f"Removed session from tracking: {session_key}")
        return True
    
    def _remove_oldest_session_for_user(self, user_id: str) -> bool:
        """Remove the oldest session for a specific user."""
        user_sessions = [
            (key, info) for key, info in self._sessions.items() 
            if info.user_id == user_id
        ]
        
        if not user_sessions:
            return False
        
        # Find oldest session
        oldest_key, oldest_info = min(user_sessions, key=lambda x: x[1].created_at)
        
        # Remove it (this will be synchronous removal, ADK deletion happens in background)
        asyncio.create_task(self.remove_session(oldest_key))
        logger.info(f"Removed oldest session for user {user_id}: {oldest_key}")
        return True
    
    def _start_cleanup_task_if_needed(self) -> None:
        """Start the cleanup task if auto cleanup is enabled and not already started."""
        if self._auto_cleanup and not self._cleanup_started:
            try:
                loop = asyncio.get_running_loop()
                self._cleanup_task = loop.create_task(self._cleanup_loop())
                self._cleanup_started = True
                logger.info("Started automatic session cleanup task")
            except RuntimeError:
                # No event loop running
                logger.debug("No event loop running, cleanup task will start later")
    
    async def _cleanup_loop(self) -> None:
        """Background task that periodically cleans up expired sessions."""
        while True:
            try:
                await asyncio.sleep(self._cleanup_interval)
                
                expired_sessions = self.get_expired_sessions()
                if expired_sessions:
                    logger.info(f"Cleaning up {len(expired_sessions)} expired sessions")
                    
                    for session_dict in expired_sessions:
                        session_key = session_dict["session_key"]
                        await self.remove_session(session_key)
                
            except asyncio.CancelledError:
                logger.info("Session cleanup task cancelled")
                break
            except Exception as e:
                logger.error(f"Error in session cleanup: {e}", exc_info=True)
                # Continue running despite errors
    
    async def stop_cleanup_task(self) -> None:
        """Stop the automatic cleanup task."""
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None
            self._cleanup_started = False
            logger.info("Stopped session cleanup task")
    
    def get_session_count(self) -> int:
        """Get total number of active sessions."""
        return len(self._sessions)
    
    def get_user_session_count(self, user_id: str) -> int:
        """Get number of active sessions for a specific user."""
        return self._user_session_counts.get(user_id, 0)
    
    def clear_all_sessions(self) -> None:
        """Clear all session tracking (for testing purposes)."""
        self._sessions.clear()
        self._user_session_counts.clear()
        logger.info("Cleared all session tracking")