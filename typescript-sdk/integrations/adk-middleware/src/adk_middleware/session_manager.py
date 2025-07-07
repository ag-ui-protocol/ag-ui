# src/session_manager.py

"""Session manager that adds production features to ADK's native session service."""

from typing import Dict, Optional, Set, Any
import asyncio
import logging
import time

logger = logging.getLogger(__name__)


class SessionManager:
    """Session manager that wraps ADK's session service.
    
    Adds essential production features:
    - Timeout monitoring based on ADK's lastUpdateTime
    - Cross-user/app session enumeration
    - Per-user session limits
    - Automatic cleanup of expired sessions
    - Optional automatic session memory on deletion
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
        memory_service=None,
        session_timeout_seconds: int = 1200,  # 20 minutes default
        cleanup_interval_seconds: int = 300,  # 5 minutes
        max_sessions_per_user: Optional[int] = None,
        auto_cleanup: bool = True
    ):
        """Initialize the session manager.
        
        Args:
            session_service: ADK session service (required on first initialization)
            memory_service: Optional ADK memory service for automatic session memory
            session_timeout_seconds: Time before a session is considered expired
            cleanup_interval_seconds: Interval between cleanup cycles
            max_sessions_per_user: Maximum concurrent sessions per user (None = unlimited)
            auto_cleanup: Enable automatic session cleanup task
        """
        if self._initialized:
            return
            
        if session_service is None:
            from google.adk.sessions import InMemorySessionService
            session_service = InMemorySessionService()
            
        self._session_service = session_service
        self._memory_service = memory_service
        self._timeout = session_timeout_seconds
        self._cleanup_interval = cleanup_interval_seconds
        self._max_per_user = max_sessions_per_user
        self._auto_cleanup = auto_cleanup
        
        # Minimal tracking: just keys and user counts
        self._session_keys: Set[str] = set()  # "app_name:session_id" keys
        self._user_sessions: Dict[str, Set[str]] = {}  # user_id -> set of session_keys
        
        self._cleanup_task: Optional[asyncio.Task] = None
        self._initialized = True
        
        logger.info(
            f"Initialized SessionManager - "
            f"timeout: {session_timeout_seconds}s, "
            f"cleanup: {cleanup_interval_seconds}s, "
            f"max/user: {max_sessions_per_user or 'unlimited'}, "
            f"memory: {'enabled' if memory_service else 'disabled'}"
        )
    
    @classmethod
    def get_instance(cls, **kwargs):
        """Get the singleton instance."""
        return cls(**kwargs)
    
    @classmethod
    def reset_instance(cls):
        """Reset singleton for testing."""
        if cls._instance and hasattr(cls._instance, '_cleanup_task'):
            task = cls._instance._cleanup_task
            if task:
                try:
                    task.cancel()
                except RuntimeError:
                    pass
        cls._instance = None
        cls._initialized = False
    
    async def get_or_create_session(
        self,
        session_id: str,
        app_name: str,
        user_id: str,
        initial_state: Optional[Dict[str, Any]] = None
    ) -> Any:
        """Get existing session or create new one.
        
        Returns the ADK session object directly.
        """
        session_key = f"{app_name}:{session_id}"
        
        # Check user limits before creating
        if session_key not in self._session_keys and self._max_per_user:
            user_count = len(self._user_sessions.get(user_id, set()))
            if user_count >= self._max_per_user:
                # Remove oldest session for this user
                await self._remove_oldest_user_session(user_id)
        
        # Get or create via ADK
        session = await self._session_service.get_session(
            session_id=session_id,
            app_name=app_name,
            user_id=user_id
        )
        
        if not session:
            session = await self._session_service.create_session(
                session_id=session_id,
                user_id=user_id,
                app_name=app_name,
                state=initial_state or {}
            )
            logger.info(f"Created new session: {session_key}")
        else:
            logger.debug(f"Retrieved existing session: {session_key}")
        
        # Track the session key
        self._track_session(session_key, user_id)
        
        # Start cleanup if needed
        if self._auto_cleanup and not self._cleanup_task:
            self._start_cleanup_task()
        
        return session
    
    def _track_session(self, session_key: str, user_id: str):
        """Track a session key for enumeration."""
        self._session_keys.add(session_key)
        
        if user_id not in self._user_sessions:
            self._user_sessions[user_id] = set()
        self._user_sessions[user_id].add(session_key)
    
    def _untrack_session(self, session_key: str, user_id: str):
        """Remove session tracking."""
        self._session_keys.discard(session_key)
        
        if user_id in self._user_sessions:
            self._user_sessions[user_id].discard(session_key)
            if not self._user_sessions[user_id]:
                del self._user_sessions[user_id]
    
    async def _remove_oldest_user_session(self, user_id: str):
        """Remove the oldest session for a user based on lastUpdateTime."""
        if user_id not in self._user_sessions:
            return
        
        oldest_key = None
        oldest_time = float('inf')
        
        # Find oldest session by checking ADK's lastUpdateTime
        for session_key in self._user_sessions[user_id]:
            app_name, session_id = session_key.split(':', 1)
            try:
                session = await self._session_service.get_session(
                    session_id=session_id,
                    app_name=app_name,
                    user_id=user_id
                )
                if session and hasattr(session, 'last_update_time'):
                    update_time = session.last_update_time
                    if update_time < oldest_time:
                        oldest_time = update_time
                        oldest_key = session_key
            except Exception as e:
                logger.error(f"Error checking session {session_key}: {e}")
        
        if oldest_key:
            app_name, session_id = oldest_key.split(':', 1)
            await self._delete_session(session_id, app_name, user_id)
            logger.info(f"Removed oldest session for user {user_id}: {oldest_key}")
    
    async def _delete_session(self, session_id: str, app_name: str, user_id: str):
        """Delete a session and untrack it."""
        session_key = f"{app_name}:{session_id}"
        
        # If memory service is available, add session to memory before deletion
        if self._memory_service:
            try:
                session = await self._session_service.get_session(
                    session_id=session_id,
                    app_name=app_name,
                    user_id=user_id
                )
                if session:
                    await self._memory_service.add_session_to_memory(
                        session_id=session_id,
                        app_name=app_name,
                        user_id=user_id,
                        session=session
                    )
                    logger.debug(f"Added session {session_key} to memory before deletion")
            except Exception as e:
                logger.error(f"Failed to add session {session_key} to memory: {e}")
        
        try:
            await self._session_service.delete_session(
                session_id=session_id,
                app_name=app_name,
                user_id=user_id
            )
            logger.debug(f"Deleted session: {session_key}")
        except Exception as e:
            logger.error(f"Failed to delete session {session_key}: {e}")
        
        self._untrack_session(session_key, user_id)
    
    def _start_cleanup_task(self):
        """Start the cleanup task if not already running."""
        try:
            loop = asyncio.get_running_loop()
            self._cleanup_task = loop.create_task(self._cleanup_loop())
            logger.info("Started session cleanup task")
        except RuntimeError:
            logger.debug("No event loop, cleanup will start later")
    
    async def _cleanup_loop(self):
        """Periodically clean up expired sessions."""
        while True:
            try:
                await asyncio.sleep(self._cleanup_interval)
                await self._cleanup_expired_sessions()
            except asyncio.CancelledError:
                logger.info("Cleanup task cancelled")
                break
            except Exception as e:
                logger.error(f"Cleanup error: {e}", exc_info=True)
    
    async def _cleanup_expired_sessions(self):
        """Find and remove expired sessions based on lastUpdateTime."""
        current_time = time.time()
        expired_count = 0
        
        # Check all tracked sessions
        for session_key in list(self._session_keys):  # Copy to avoid modification during iteration
            app_name, session_id = session_key.split(':', 1)
            
            # Find user_id for this session
            user_id = None
            for uid, keys in self._user_sessions.items():
                if session_key in keys:
                    user_id = uid
                    break
            
            if not user_id:
                continue
            
            try:
                session = await self._session_service.get_session(
                    session_id=session_id,
                    app_name=app_name,
                    user_id=user_id
                )
                
                if session and hasattr(session, 'last_update_time'):
                    age = current_time - session.last_update_time
                    if age > self._timeout:
                        await self._delete_session(session_id, app_name, user_id)
                        expired_count += 1
                elif not session:
                    # Session doesn't exist, just untrack it
                    self._untrack_session(session_key, user_id)
                    
            except Exception as e:
                logger.error(f"Error checking session {session_key}: {e}")
        
        if expired_count > 0:
            logger.info(f"Cleaned up {expired_count} expired sessions")
    
    def get_session_count(self) -> int:
        """Get total number of tracked sessions."""
        return len(self._session_keys)
    
    def get_user_session_count(self, user_id: str) -> int:
        """Get number of sessions for a user."""
        return len(self._user_sessions.get(user_id, set()))
    
    async def stop_cleanup_task(self):
        """Stop the cleanup task."""
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None