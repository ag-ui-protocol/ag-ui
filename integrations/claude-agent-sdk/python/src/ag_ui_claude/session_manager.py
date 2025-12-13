"""Session manager for Claude SDK integration."""

from typing import Dict, Optional, Set, Any, List, Union
import asyncio
import logging
import time

logger = logging.getLogger(__name__)


class SessionManager:
    """Session manager for Claude SDK sessions.
    
    Manages conversation sessions, message tracking, and state management.
    Supports both persistent client sessions and stateless query mode.
    """
    
    _instance = None
    _initialized = False
    
    def __new__(cls, **kwargs):
        """Ensure singleton instance."""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    def __init__(
        self,
        session_timeout_seconds: int = 1200,  # 20 minutes default
        cleanup_interval_seconds: int = 300,  # 5 minutes
        max_sessions_per_user: Optional[int] = None,
        auto_cleanup: bool = True
    ):
        """Initialize the session manager.
        
        Args:
            session_timeout_seconds: Time before a session is considered expired
            cleanup_interval_seconds: Interval between cleanup cycles
            max_sessions_per_user: Maximum concurrent sessions per user (None = unlimited)
            auto_cleanup: Enable automatic session cleanup task
        """
        if self._initialized:
            return
        
        self._timeout = session_timeout_seconds
        self._cleanup_interval = cleanup_interval_seconds
        self._max_per_user = max_sessions_per_user
        self._auto_cleanup = auto_cleanup
        
        # Session tracking
        self._sessions: Dict[str, Dict[str, Any]] = {}  # session_key -> session_data
        self._session_keys: Set[str] = set()  # "app_name:session_id" keys
        self._user_sessions: Dict[str, Set[str]] = {}  # user_id -> set of session_keys
        self._processed_message_ids: Dict[str, Set[str]] = {}  # session_key -> set of message_ids
        self._claude_clients: Dict[str, Any] = {}  # session_key -> Claude SDK client (if using persistent mode)
        
        self._cleanup_task: Optional[asyncio.Task] = None
        self._initialized = True
        
        logger.info(
            f"Initialized SessionManager - "
            f"timeout: {session_timeout_seconds}s, "
            f"cleanup: {cleanup_interval_seconds}s, "
            f"max/user: {max_sessions_per_user or 'unlimited'}"
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
    
    def _make_session_key(self, app_name: str, session_id: str) -> str:
        """Create a session key."""
        return f"{app_name}:{session_id}"
    
    def _track_session(self, session_key: str, user_id: str):
        """Track a session key."""
        self._session_keys.add(session_key)
        if user_id not in self._user_sessions:
            self._user_sessions[user_id] = set()
        self._user_sessions[user_id].add(session_key)
    
    def _untrack_session(self, session_key: str, user_id: str):
        """Remove session tracking."""
        self._session_keys.discard(session_key)
        self._sessions.pop(session_key, None)
        self._processed_message_ids.pop(session_key, None)
        self._claude_clients.pop(session_key, None)
        
        if user_id in self._user_sessions:
            self._user_sessions[user_id].discard(session_key)
            if not self._user_sessions[user_id]:
                del self._user_sessions[user_id]
    
    async def get_or_create_session(
        self,
        session_id: str,
        app_name: str,
        user_id: str,
        initial_state: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Get existing session or create new one.
        
        Returns session data dictionary.
        """
        session_key = self._make_session_key(app_name, session_id)
        
        # Check user limits before creating
        if session_key not in self._session_keys and self._max_per_user:
            user_count = len(self._user_sessions.get(user_id, set()))
            if user_count >= self._max_per_user:
                await self._remove_oldest_user_session(user_id)
        
        if session_key not in self._sessions:
            # Create new session
            self._sessions[session_key] = {
                "session_id": session_id,
                "app_name": app_name,
                "user_id": user_id,
                "state": initial_state or {},
                "created_at": time.time(),
                "last_update_time": time.time(),
                "messages": []
            }
            logger.info(f"Created new session: {session_key}")
        else:
            # Update last access time
            self._sessions[session_key]["last_update_time"] = time.time()
            logger.debug(f"Retrieved existing session: {session_key}")
        
        # Track the session
        self._track_session(session_key, user_id)
        
        # Start cleanup if needed
        if self._auto_cleanup and not self._cleanup_task:
            self._start_cleanup_task()
        
        return self._sessions[session_key]
    
    def get_processed_message_ids(self, app_name: str, session_id: str) -> Set[str]:
        """Get processed message IDs for a session."""
        session_key = self._make_session_key(app_name, session_id)
        return set(self._processed_message_ids.get(session_key, set()))
    
    def mark_messages_processed(
        self,
        app_name: str,
        session_id: str,
        message_ids: Set[str],
    ) -> None:
        """Mark messages as processed."""
        session_key = self._make_session_key(app_name, session_id)
        processed_ids = self._processed_message_ids.setdefault(session_key, set())
        processed_ids.update(message_ids)
    
    async def update_session_state(
        self,
        session_id: str,
        app_name: str,
        user_id: str,
        state_updates: Dict[str, Any],
        merge: bool = True
    ) -> bool:
        """Update session state.
        
        Args:
            session_id: Session identifier
            app_name: Application name
            user_id: User identifier
            state_updates: Dictionary of state key-value pairs to update
            merge: If True, merge with existing state; if False, replace completely
            
        Returns:
            True if successful, False otherwise
        """
        try:
            session_key = self._make_session_key(app_name, session_id)
            if session_key not in self._sessions:
                logger.debug(f"Session not found for update: {session_key}")
                return False
            
            if merge:
                self._sessions[session_key]["state"].update(state_updates)
            else:
                self._sessions[session_key]["state"] = state_updates
            
            self._sessions[session_key]["last_update_time"] = time.time()
            logger.debug(f"Updated state for session {session_key}")
            return True
        except Exception as e:
            logger.error(f"Failed to update session state: {e}", exc_info=True)
            return False
    
    async def get_session_state(
        self,
        session_id: str,
        app_name: str,
        user_id: str
    ) -> Optional[Dict[str, Any]]:
        """Get current session state."""
        try:
            session_key = self._make_session_key(app_name, session_id)
            if session_key not in self._sessions:
                return None
            return self._sessions[session_key].get("state", {})
        except Exception as e:
            logger.error(f"Failed to get session state: {e}", exc_info=True)
            return None
    
    async def get_state_value(
        self,
        session_id: str,
        app_name: str,
        user_id: str,
        key: str,
        default: Any = None
    ) -> Any:
        """Get a specific state value by key.
        
        Args:
            session_id: Session identifier
            app_name: Application name
            user_id: User identifier
            key: State key to retrieve
            default: Default value if key not found
            
        Returns:
            State value or default
        """
        state = await self.get_session_state(session_id, app_name, user_id)
        if state is None:
            return default
        return state.get(key, default)
    
    async def set_state_value(
        self,
        session_id: str,
        app_name: str,
        user_id: str,
        key: str,
        value: Any
    ) -> bool:
        """Set a specific state value by key.
        
        Args:
            session_id: Session identifier
            app_name: Application name
            user_id: User identifier
            key: State key to set
            value: Value to set
            
        Returns:
            True if successful, False otherwise
        """
        return await self.update_session_state(
            session_id=session_id,
            app_name=app_name,
            user_id=user_id,
            state_updates={key: value}
        )
    
    async def remove_state_keys(
        self,
        session_id: str,
        app_name: str,
        user_id: str,
        keys: Union[str, List[str]]
    ) -> bool:
        """Remove one or more state keys.
        
        Args:
            session_id: Session identifier
            app_name: Application name
            user_id: User identifier
            keys: Key or list of keys to remove
            
        Returns:
            True if successful, False otherwise
        """
        try:
            session_key = self._make_session_key(app_name, session_id)
            if session_key not in self._sessions:
                return False
            
            if isinstance(keys, str):
                keys = [keys]
            
            state = self._sessions[session_key].get("state", {})
            for key in keys:
                state.pop(key, None)
            
            self._sessions[session_key]["last_update_time"] = time.time()
            logger.debug(f"Removed state keys {keys} from session {session_key}")
            return True
        except Exception as e:
            logger.error(f"Failed to remove state keys: {e}", exc_info=True)
            return False
    
    async def clear_session_state(
        self,
        session_id: str,
        app_name: str,
        user_id: str,
        preserve_prefixes: Optional[List[str]] = None
    ) -> bool:
        """Clear session state, optionally preserving keys with specific prefixes.
        
        Args:
            session_id: Session identifier
            app_name: Application name
            user_id: User identifier
            preserve_prefixes: List of prefixes to preserve (e.g., ["user_", "app_"])
            
        Returns:
            True if successful, False otherwise
        """
        try:
            session_key = self._make_session_key(app_name, session_id)
            if session_key not in self._sessions:
                return False
            
            state = self._sessions[session_key].get("state", {})
            preserve_prefixes = preserve_prefixes or []
            
            # Build new state with preserved keys
            new_state = {}
            for key, value in state.items():
                should_preserve = any(key.startswith(prefix) for prefix in preserve_prefixes)
                if should_preserve:
                    new_state[key] = value
            
            self._sessions[session_key]["state"] = new_state
            self._sessions[session_key]["last_update_time"] = time.time()
            logger.debug(f"Cleared session state for {session_key}, preserved {len(new_state)} keys")
            return True
        except Exception as e:
            logger.error(f"Failed to clear session state: {e}", exc_info=True)
            return False
    
    def get_session_count(self) -> int:
        """Get total number of active sessions.
        
        Returns:
            Number of active sessions
        """
        return len(self._session_keys)
    
    def get_user_session_count(self, user_id: str) -> int:
        """Get number of active sessions for a specific user.
        
        Args:
            user_id: User identifier
            
        Returns:
            Number of active sessions for the user
        """
        return len(self._user_sessions.get(user_id, set()))
    
    def get_claude_client(self, session_key: str) -> Optional[Any]:
        """Get Claude SDK client for a session (if using persistent mode)."""
        return self._claude_clients.get(session_key)
    
    def set_claude_client(self, session_key: str, client: Any):
        """Set Claude SDK client for a session."""
        self._claude_clients[session_key] = client
    
    def _start_cleanup_task(self):
        """Start the cleanup task if not already running."""
        try:
            loop = asyncio.get_running_loop()
            self._cleanup_task = loop.create_task(self._cleanup_loop())
            logger.debug(f"Started session cleanup task")
        except RuntimeError:
            logger.debug("No event loop, cleanup will start later")
    
    async def _cleanup_loop(self):
        """Periodically clean up expired sessions."""
        logger.debug("Cleanup loop started")
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
        """Clean up expired sessions and disconnect ClaudeSDKClient connections."""
        current_time = time.time()
        expired_count = 0
        
        for session_key in list(self._session_keys):
            session = self._sessions.get(session_key)
            if not session:
                continue
            
            age = current_time - session["last_update_time"]
            if age > self._timeout:
                # Check for pending tool calls before deletion (HITL scenarios)
                pending_calls = session.get("state", {}).get("pending_tool_calls", [])
                if pending_calls:
                    logger.info(f"Preserving expired session {session_key} - has {len(pending_calls)} pending tool calls")
                else:
                    user_id = session["user_id"]
                    self._untrack_session(session_key, user_id)
                    expired_count += 1
        
        if expired_count > 0:
            logger.info(f"Cleaned up {expired_count} expired sessions")
    
    async def _remove_oldest_user_session(self, user_id: str):
        """Remove the oldest session for a user."""
        if user_id not in self._user_sessions:
            return
        
        oldest_session_key = None
        oldest_time = float('inf')
        
        for session_key in self._user_sessions[user_id]:
            session = self._sessions.get(session_key)
            if session and session["last_update_time"] < oldest_time:
                oldest_time = session["last_update_time"]
                oldest_session_key = session_key
        
        if oldest_session_key:
            self._untrack_session(oldest_session_key, user_id)
            logger.info(f"Removed oldest session for user {user_id}: {oldest_session_key}")
    
    async def stop_cleanup_task(self):
        """Stop the cleanup task."""
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None

