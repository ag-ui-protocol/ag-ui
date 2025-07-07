#!/usr/bin/env python
"""Test session memory integration functionality."""

import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock
from datetime import datetime
import time


from adk_middleware import SessionManager
class TestSessionMemory:
    """Test cases for automatic session memory functionality."""
    
    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager before each test."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()
    
    @pytest.fixture
    def mock_session_service(self):
        """Create a mock session service."""
        service = AsyncMock()
        service.get_session = AsyncMock()
        service.create_session = AsyncMock()
        service.delete_session = AsyncMock()
        return service
    
    @pytest.fixture
    def mock_memory_service(self):
        """Create a mock memory service."""
        service = AsyncMock()
        service.add_session_to_memory = AsyncMock()
        return service
    
    @pytest.fixture
    def mock_session(self):
        """Create a mock ADK session object."""
        session = MagicMock()
        session.lastUpdateTime = datetime.fromtimestamp(time.time())
        session.state = {"test": "data"}
        session.id = "test_session"
        return session
    
    @pytest.mark.asyncio
    async def test_memory_service_disabled_by_default(self, mock_session_service):
        """Test that memory service is disabled when not provided."""
        manager = SessionManager.get_instance(
            session_service=mock_session_service,
            auto_cleanup=False
        )
        
        # Verify memory service is None
        assert manager._memory_service is None
        
        # Create and delete a session - memory service should not be called
        mock_session_service.get_session.return_value = None
        mock_session_service.create_session.return_value = MagicMock()
        
        await manager.get_or_create_session("test_session", "test_app", "test_user")
        await manager._delete_session("test_session", "test_app", "test_user")
        
        # Only session service delete should be called
        mock_session_service.delete_session.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_memory_service_enabled_with_service(self, mock_session_service, mock_memory_service, mock_session):
        """Test that memory service is called when provided."""
        manager = SessionManager.get_instance(
            session_service=mock_session_service,
            memory_service=mock_memory_service,
            auto_cleanup=False
        )
        
        # Verify memory service is set
        assert manager._memory_service is mock_memory_service
        
        # Mock session retrieval for deletion
        mock_session_service.get_session.return_value = mock_session
        
        # Delete a session
        await manager._delete_session("test_session", "test_app", "test_user")
        
        # Verify memory service was called with correct parameters
        mock_memory_service.add_session_to_memory.assert_called_once_with(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            session=mock_session
        )
        
        # Verify session was also deleted from session service
        mock_session_service.delete_session.assert_called_once_with(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user"
        )
    
    @pytest.mark.asyncio
    async def test_memory_service_error_handling(self, mock_session_service, mock_memory_service, mock_session):
        """Test that memory service errors don't prevent session deletion."""
        manager = SessionManager.get_instance(
            session_service=mock_session_service,
            memory_service=mock_memory_service,
            auto_cleanup=False
        )
        
        # Mock session retrieval
        mock_session_service.get_session.return_value = mock_session
        
        # Make memory service fail
        mock_memory_service.add_session_to_memory.side_effect = Exception("Memory service error")
        
        # Delete should still succeed despite memory service error
        await manager._delete_session("test_session", "test_app", "test_user")
        
        # Verify both were called despite memory service error
        mock_memory_service.add_session_to_memory.assert_called_once()
        mock_session_service.delete_session.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_memory_service_with_missing_session(self, mock_session_service, mock_memory_service):
        """Test memory service behavior when session doesn't exist."""
        manager = SessionManager.get_instance(
            session_service=mock_session_service,
            memory_service=mock_memory_service,
            auto_cleanup=False
        )
        
        # Mock session as not found
        mock_session_service.get_session.return_value = None
        
        # Delete a non-existent session
        await manager._delete_session("test_session", "test_app", "test_user")
        
        # Memory service should not be called for non-existent session
        mock_memory_service.add_session_to_memory.assert_not_called()
        
        # Session service delete should still be called
        mock_session_service.delete_session.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_memory_service_during_cleanup(self, mock_session_service, mock_memory_service):
        """Test that memory service is used during automatic cleanup."""
        manager = SessionManager.get_instance(
            session_service=mock_session_service,
            memory_service=mock_memory_service,
            session_timeout_seconds=1,  # 1 second timeout
            auto_cleanup=False  # We'll trigger cleanup manually
        )
        
        # Create an expired session
        old_session = MagicMock()
        old_session.lastUpdateTime = datetime.fromtimestamp(time.time() - 10)  # 10 seconds ago
        
        # Track a session manually for testing
        manager._track_session("test_app:test_session", "test_user")
        
        # Mock session retrieval to return the expired session
        mock_session_service.get_session.return_value = old_session
        
        # Trigger cleanup
        await manager._cleanup_expired_sessions()
        
        # Verify memory service was called during cleanup
        mock_memory_service.add_session_to_memory.assert_called_once_with(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            session=old_session
        )
    
    @pytest.mark.asyncio
    async def test_memory_service_during_user_limit_enforcement(self, mock_session_service, mock_memory_service):
        """Test that memory service is used when removing oldest sessions due to user limits."""
        manager = SessionManager.get_instance(
            session_service=mock_session_service,
            memory_service=mock_memory_service,
            max_sessions_per_user=1,  # Limit to 1 session per user
            auto_cleanup=False
        )
        
        # Create an old session that will be removed
        old_session = MagicMock()
        old_session.lastUpdateTime = datetime.fromtimestamp(time.time() - 60)  # 1 minute ago
        
        # Mock initial session creation and retrieval
        mock_session_service.get_session.return_value = None
        mock_session_service.create_session.return_value = MagicMock()
        
        # Create first session
        await manager.get_or_create_session("session1", "test_app", "test_user")
        
        # Now mock the old session for limit enforcement
        def mock_get_session_side_effect(session_id, app_name, user_id):
            if session_id == "session1":
                return old_session
            return None
        
        mock_session_service.get_session.side_effect = mock_get_session_side_effect
        
        # Create second session - should trigger removal of first session
        await manager.get_or_create_session("session2", "test_app", "test_user")
        
        # Verify memory service was called for the removed session
        mock_memory_service.add_session_to_memory.assert_called_once_with(
            session_id="session1",
            app_name="test_app",
            user_id="test_user",
            session=old_session
        )
    
    @pytest.mark.asyncio
    async def test_memory_service_configuration(self, mock_session_service, mock_memory_service):
        """Test that memory service configuration is properly stored."""
        # Test with memory service enabled
        SessionManager.reset_instance()
        manager = SessionManager.get_instance(
            session_service=mock_session_service,
            memory_service=mock_memory_service
        )
        
        assert manager._memory_service is mock_memory_service
        
        # Test with memory service disabled
        SessionManager.reset_instance()
        manager = SessionManager.get_instance(
            session_service=mock_session_service,
            memory_service=None
        )
        
        assert manager._memory_service is None