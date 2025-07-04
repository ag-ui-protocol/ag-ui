# src/session_manager.py

"""Session lifecycle management for ADK middleware."""

from typing import Dict, Optional, List, Any
import time
import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class SessionInfo:
    """Information about an active session."""
    session_key: str
    agent_id: str
    user_id: str
    session_id: str
    last_activity: float
    created_at: float


class SessionLifecycleManager:
    """Manages session lifecycle including timeouts and cleanup.
    
    This class tracks active sessions, monitors for timeouts, and
    manages per-user session limits.
    """
    
    def __init__(
        self,
        session_timeout_seconds: int = 3600,  # 1 hour default
        cleanup_interval_seconds: int = 300,  # 5 minutes
        max_sessions_per_user: Optional[int] = None
    ):
        """Initialize the session lifecycle manager.
        
        Args:
            session_timeout_seconds: Time before a session is considered expired
            cleanup_interval_seconds: Interval between cleanup cycles
            max_sessions_per_user: Maximum concurrent sessions per user (None = unlimited)
        """
        self._session_timeout = session_timeout_seconds
        self._cleanup_interval = cleanup_interval_seconds
        self._max_sessions_per_user = max_sessions_per_user
        
        # Track sessions: session_key -> SessionInfo
        self._sessions: Dict[str, SessionInfo] = {}
        
        # Track user session counts for quick lookup
        self._user_session_counts: Dict[str, int] = {}
        
        logger.info(
            f"Initialized SessionLifecycleManager - "
            f"timeout: {session_timeout_seconds}s, "
            f"cleanup interval: {cleanup_interval_seconds}s, "
            f"max per user: {max_sessions_per_user or 'unlimited'}"
        )
    
    def track_activity(
        self, 
        session_key: str,
        agent_id: str,
        user_id: str,
        session_id: str
    ) -> None:
        """Track activity for a session.
        
        Args:
            session_key: Unique key for the session (agent_id:user_id:session_id)
            agent_id: The agent ID
            user_id: The user ID
            session_id: The session ID (thread_id)
        """
        current_time = time.time()
        
        if session_key not in self._sessions:
            # New session
            session_info = SessionInfo(
                session_key=session_key,
                agent_id=agent_id,
                user_id=user_id,
                session_id=session_id,
                last_activity=current_time,
                created_at=current_time
            )
            self._sessions[session_key] = session_info
            
            # Update user session count
            self._user_session_counts[user_id] = self._user_session_counts.get(user_id, 0) + 1
            
            logger.debug(f"New session tracked: {session_key}")
        else:
            # Update existing session
            self._sessions[session_key].last_activity = current_time
            logger.debug(f"Updated activity for session: {session_key}")
    
    def should_create_new_session(self, user_id: str) -> bool:
        """Check if a new session would exceed the user's limit.
        
        Args:
            user_id: The user ID to check
            
        Returns:
            True if creating a new session would exceed the limit
        """
        if self._max_sessions_per_user is None:
            return False
        
        current_count = self._user_session_counts.get(user_id, 0)
        return current_count >= self._max_sessions_per_user
    
    def get_expired_sessions(self) -> List[Dict[str, Any]]:
        """Get all sessions that have exceeded the timeout.
        
        Returns:
            List of expired session information dictionaries
        """
        current_time = time.time()
        expired = []
        
        for session_info in self._sessions.values():
            time_since_activity = current_time - session_info.last_activity
            if time_since_activity > self._session_timeout:
                expired.append({
                    "session_key": session_info.session_key,
                    "agent_id": session_info.agent_id,
                    "user_id": session_info.user_id,
                    "session_id": session_info.session_id,
                    "last_activity": session_info.last_activity,
                    "created_at": session_info.created_at,
                    "inactive_seconds": time_since_activity
                })
        
        if expired:
            logger.info(f"Found {len(expired)} expired sessions")
        
        return expired
    
    def get_oldest_session_for_user(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Get the oldest session for a specific user.
        
        Args:
            user_id: The user ID
            
        Returns:
            Session information for the oldest session, or None if no sessions
        """
        user_sessions = [
            session_info for session_info in self._sessions.values()
            if session_info.user_id == user_id
        ]
        
        if not user_sessions:
            return None
        
        # Sort by last activity (oldest first)
        oldest = min(user_sessions, key=lambda s: s.last_activity)
        
        return {
            "session_key": oldest.session_key,
            "agent_id": oldest.agent_id,
            "user_id": oldest.user_id,
            "session_id": oldest.session_id,
            "last_activity": oldest.last_activity,
            "created_at": oldest.created_at
        }
    
    def remove_session(self, session_key: str) -> None:
        """Remove a session from tracking.
        
        Args:
            session_key: The session key to remove
        """
        if session_key in self._sessions:
            session_info = self._sessions.pop(session_key)
            
            # Update user session count
            user_id = session_info.user_id
            if user_id in self._user_session_counts:
                self._user_session_counts[user_id] = max(0, self._user_session_counts[user_id] - 1)
                if self._user_session_counts[user_id] == 0:
                    del self._user_session_counts[user_id]
            
            logger.debug(f"Removed session: {session_key}")
    
    def get_session_count(self, user_id: Optional[str] = None) -> int:
        """Get the count of active sessions.
        
        Args:
            user_id: If provided, get count for specific user. Otherwise, get total.
            
        Returns:
            Number of active sessions
        """
        if user_id:
            return self._user_session_counts.get(user_id, 0)
        else:
            return len(self._sessions)
    
    def get_all_sessions(self) -> List[Dict[str, Any]]:
        """Get information about all active sessions.
        
        Returns:
            List of session information dictionaries
        """
        current_time = time.time()
        return [
            {
                "session_key": info.session_key,
                "agent_id": info.agent_id,
                "user_id": info.user_id,
                "session_id": info.session_id,
                "last_activity": info.last_activity,
                "created_at": info.created_at,
                "inactive_seconds": current_time - info.last_activity,
                "age_seconds": current_time - info.created_at
            }
            for info in self._sessions.values()
        ]
    
    def clear(self) -> None:
        """Clear all tracked sessions."""
        self._sessions.clear()
        self._user_session_counts.clear()
        logger.info("Cleared all sessions from lifecycle manager")