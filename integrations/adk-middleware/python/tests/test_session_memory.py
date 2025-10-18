#!/usr/bin/env python
"""Extended test session memory integration functionality with state management tests."""

import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from datetime import datetime
import time

from ag_ui_adk import SessionManager


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
        service.append_event = AsyncMock()
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
        class MockState(dict):
            def to_dict(self):
                return dict(self)

        session = MagicMock()
        session.last_update_time = datetime.fromtimestamp(time.time())
        session.state = MockState({"test": "data", "user_id": "test_user", "counter": 42})
        session.id = "test_session"
        session.app_name = "test_app"
        session.user_id = "test_user"

        return session

    # ===== EXISTING MEMORY TESTS =====

    @pytest.mark.asyncio
    async def test_memory_service_disabled_by_default(self, mock_session_service, mock_session):
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
        await manager._delete_session(mock_session)

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

        # Delete a session using session object
        await manager._delete_session(mock_session)

        # Verify memory service was called with correct parameters
        mock_memory_service.add_session_to_memory.assert_called_once_with(mock_session)

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

        # Make memory service fail
        mock_memory_service.add_session_to_memory.side_effect = Exception("Memory service error")

        # Delete should still succeed despite memory service error
        await manager._delete_session(mock_session)

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

        # Delete a None session (simulates session not found)
        await manager._delete_session(None)

        # Memory service should not be called for non-existent session
        mock_memory_service.add_session_to_memory.assert_not_called()

        # Session service delete should also not be called for None session
        mock_session_service.delete_session.assert_not_called()

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
        old_session.last_update_time = time.time() - 10  # 10 seconds ago
        old_session.state = {}  # No pending tool calls

        # Track a session manually for testing
        manager._track_session("test_app:test_session", "test_user")

        # Mock session retrieval to return the expired session
        mock_session_service.get_session.return_value = old_session

        # Trigger cleanup
        await manager._cleanup_expired_sessions()

        # Verify memory service was called during cleanup
        mock_memory_service.add_session_to_memory.assert_called_once_with(old_session)

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
        old_session.last_update_time = time.time() - 60  # 1 minute ago

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
        mock_memory_service.add_session_to_memory.assert_called_once_with(old_session)

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


class TestSessionStateManagement:
    """Test cases for session state management functionality."""

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
        service.append_event = AsyncMock()
        return service

    @pytest.fixture
    def mock_session(self):
        """Create a mock ADK session object with state."""

        class MockState(dict):
            def to_dict(self):
                return dict(self)

        session = MagicMock()
        session.last_update_time = datetime.fromtimestamp(time.time())
        session.state = MockState({
            "test": "data",
            "user_id": "test_user",
            "counter": 42,
            "app:setting": "value"
        })
        session.id = "test_session"
        session.app_name = "test_app"
        session.user_id = "test_user"

        return session

    @pytest.fixture
    def manager(self, mock_session_service):
        """Create a session manager instance."""
        return SessionManager.get_instance(
            session_service=mock_session_service,
            auto_cleanup=False
        )

    # ===== UPDATE SESSION STATE TESTS =====

    @pytest.mark.asyncio
    async def test_update_session_state_success(self, manager, mock_session_service, mock_session):
        """Test successful session state update."""
        mock_session_service.get_session.return_value = mock_session

        state_updates = {"new_key": "new_value", "counter": 100}

        with patch('google.adk.events.Event') as mock_event, \
             patch('google.adk.events.EventActions') as mock_actions:

            result = await manager.update_session_state(
                session_id="test_session",
                app_name="test_app",
                user_id="test_user",
                state_updates=state_updates
            )

            assert result is True
            mock_session_service.get_session.assert_called_once_with(
                session_id="test_session",
                app_name="test_app",
                user_id="test_user"
            )
            mock_actions.assert_called_once_with(state_delta=state_updates)
            mock_session_service.append_event.assert_called_once()

    @pytest.mark.asyncio
    async def test_update_session_state_session_not_found(self, manager, mock_session_service):
        """Test update when session doesn't exist."""
        mock_session_service.get_session.return_value = None

        result = await manager.update_session_state(
            session_id="nonexistent",
            app_name="test_app",
            user_id="test_user",
            state_updates={"key": "value"}
        )

        assert result is False
        mock_session_service.append_event.assert_not_called()

    @pytest.mark.asyncio
    async def test_update_session_state_empty_updates(self, manager, mock_session_service, mock_session):
        """Test update with empty state updates."""
        mock_session_service.get_session.return_value = mock_session

        result = await manager.update_session_state(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            state_updates={}
        )

        assert result is False
        mock_session_service.append_event.assert_not_called()

    @pytest.mark.asyncio
    async def test_update_session_state_exception_handling(self, manager, mock_session_service):
        """Test exception handling in state update."""
        mock_session_service.get_session.side_effect = Exception("Database error")

        result = await manager.update_session_state(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            state_updates={"key": "value"}
        )

        assert result is False

    # ===== GET SESSION STATE TESTS =====

    @pytest.mark.asyncio
    async def test_get_session_state_success(self, manager, mock_session_service, mock_session):
        """Test successful session state retrieval."""
        mock_session_service.get_session.return_value = mock_session

        result = await manager.get_session_state(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user"
        )

        assert result == {
            "test": "data",
            "user_id": "test_user",
            "counter": 42,
            "app:setting": "value"
        }
        mock_session_service.get_session.assert_called_once()

    @pytest.mark.asyncio
    async def test_get_session_state_session_not_found(self, manager, mock_session_service):
        """Test get state when session doesn't exist."""
        mock_session_service.get_session.return_value = None

        result = await manager.get_session_state(
            session_id="nonexistent",
            app_name="test_app",
            user_id="test_user"
        )

        assert result is None

    @pytest.mark.asyncio
    async def test_get_session_state_exception_handling(self, manager, mock_session_service):
        """Test exception handling in get state."""
        mock_session_service.get_session.side_effect = Exception("Database error")

        result = await manager.get_session_state(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user"
        )

        assert result is None

    # ===== GET STATE VALUE TESTS =====

    @pytest.mark.asyncio
    async def test_get_state_value_success(self, manager, mock_session_service, mock_session):
        """Test successful retrieval of specific state value."""
        mock_session_service.get_session.return_value = mock_session

        result = await manager.get_state_value(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            key="counter"
        )

        assert result == 42

    @pytest.mark.asyncio
    async def test_get_state_value_with_default(self, manager, mock_session_service, mock_session):
        """Test get state value with default for missing key."""
        mock_session_service.get_session.return_value = mock_session

        result = await manager.get_state_value(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            key="nonexistent_key",
            default="default_value"
        )

        assert result == "default_value"

    @pytest.mark.asyncio
    async def test_get_state_value_session_not_found(self, manager, mock_session_service):
        """Test get state value when session doesn't exist."""
        mock_session_service.get_session.return_value = None

        result = await manager.get_state_value(
            session_id="nonexistent",
            app_name="test_app",
            user_id="test_user",
            key="any_key",
            default="default_value"
        )

        assert result == "default_value"

    # ===== SET STATE VALUE TESTS =====

    @pytest.mark.asyncio
    async def test_set_state_value_success(self, manager, mock_session_service, mock_session):
        """Test successful setting of state value."""
        mock_session_service.get_session.return_value = mock_session

        with patch('google.adk.events.Event') as mock_event, \
             patch('google.adk.events.EventActions') as mock_actions:

            result = await manager.set_state_value(
                session_id="test_session",
                app_name="test_app",
                user_id="test_user",
                key="new_key",
                value="new_value"
            )

            assert result is True
            mock_actions.assert_called_once_with(state_delta={"new_key": "new_value"})

    # ===== REMOVE STATE KEYS TESTS =====

    @pytest.mark.asyncio
    async def test_remove_state_keys_single_key(self, manager, mock_session_service, mock_session):
        """Test removing a single state key."""
        mock_session_service.get_session.return_value = mock_session

        with patch.object(manager, 'get_session_state') as mock_get_state, \
             patch.object(manager, 'update_session_state') as mock_update:

            mock_get_state.return_value = {"test": "data", "counter": 42}
            mock_update.return_value = True

            result = await manager.remove_state_keys(
                session_id="test_session",
                app_name="test_app",
                user_id="test_user",
                keys="test"
            )

            assert result is True
            mock_update.assert_called_once_with(
                session_id="test_session",
                app_name="test_app",
                user_id="test_user",
                state_updates={"test": None}
            )

    @pytest.mark.asyncio
    async def test_remove_state_keys_multiple_keys(self, manager, mock_session_service, mock_session):
        """Test removing multiple state keys."""
        mock_session_service.get_session.return_value = mock_session

        with patch.object(manager, 'get_session_state') as mock_get_state, \
             patch.object(manager, 'update_session_state') as mock_update:

            mock_get_state.return_value = {"test": "data", "counter": 42, "other": "value"}
            mock_update.return_value = True

            result = await manager.remove_state_keys(
                session_id="test_session",
                app_name="test_app",
                user_id="test_user",
                keys=["test", "counter"]
            )

            assert result is True
            mock_update.assert_called_once_with(
                session_id="test_session",
                app_name="test_app",
                user_id="test_user",
                state_updates={"test": None, "counter": None}
            )

    @pytest.mark.asyncio
    async def test_remove_state_keys_nonexistent_keys(self, manager, mock_session_service, mock_session):
        """Test removing keys that don't exist."""
        mock_session_service.get_session.return_value = mock_session

        with patch.object(manager, 'get_session_state') as mock_get_state, \
             patch.object(manager, 'update_session_state') as mock_update:

            mock_get_state.return_value = {"test": "data"}
            mock_update.return_value = True

            result = await manager.remove_state_keys(
                session_id="test_session",
                app_name="test_app",
                user_id="test_user",
                keys=["nonexistent1", "nonexistent2"]
            )

            assert result is True
            mock_update.assert_not_called()  # No keys to remove

    # ===== CLEAR SESSION STATE TESTS =====

    @pytest.mark.asyncio
    async def test_clear_session_state_all_keys(self, manager, mock_session_service, mock_session):
        """Test clearing all session state."""
        mock_session_service.get_session.return_value = mock_session

        with patch.object(manager, 'get_session_state') as mock_get_state, \
             patch.object(manager, 'remove_state_keys') as mock_remove:

            mock_get_state.return_value = {"test": "data", "counter": 42, "app:setting": "value"}
            mock_remove.return_value = True

            result = await manager.clear_session_state(
                session_id="test_session",
                app_name="test_app",
                user_id="test_user"
            )

            assert result is True
            mock_remove.assert_called_once_with(
                session_id="test_session",
                app_name="test_app",
                user_id="test_user",
                keys=["test", "counter", "app:setting"]
            )

    @pytest.mark.asyncio
    async def test_clear_session_state_preserve_prefixes(self, manager, mock_session_service, mock_session):
        """Test clearing state while preserving certain prefixes."""
        mock_session_service.get_session.return_value = mock_session

        with patch.object(manager, 'get_session_state') as mock_get_state, \
             patch.object(manager, 'remove_state_keys') as mock_remove:

            mock_get_state.return_value = {"test": "data", "counter": 42, "app:setting": "value"}
            mock_remove.return_value = True

            result = await manager.clear_session_state(
                session_id="test_session",
                app_name="test_app",
                user_id="test_user",
                preserve_prefixes=["app:"]
            )

            assert result is True
            mock_remove.assert_called_once_with(
                session_id="test_session",
                app_name="test_app",
                user_id="test_user",
                keys=["test", "counter"]  # app:setting should be preserved
            )

    # ===== INITIALIZE SESSION STATE TESTS =====

    @pytest.mark.asyncio
    async def test_initialize_session_state_new_keys_only(self, manager, mock_session_service, mock_session):
        """Test initializing session state with only new keys."""
        mock_session_service.get_session.return_value = mock_session

        with patch.object(manager, 'get_session_state') as mock_get_state, \
             patch.object(manager, 'update_session_state') as mock_update:

            mock_get_state.return_value = {"existing": "value"}
            mock_update.return_value = True

            initial_state = {"existing": "old_value", "new_key": "new_value"}

            result = await manager.initialize_session_state(
                session_id="test_session",
                app_name="test_app",
                user_id="test_user",
                initial_state=initial_state,
                overwrite_existing=False
            )

            assert result is True
            mock_update.assert_called_once_with(
                session_id="test_session",
                app_name="test_app",
                user_id="test_user",
                state_updates={"new_key": "new_value"}  # Only new keys
            )

    @pytest.mark.asyncio
    async def test_initialize_session_state_overwrite_existing(self, manager, mock_session_service, mock_session):
        """Test initializing session state with overwrite enabled."""
        mock_session_service.get_session.return_value = mock_session

        with patch.object(manager, 'update_session_state') as mock_update:
            mock_update.return_value = True

            initial_state = {"existing": "new_value", "new_key": "new_value"}

            result = await manager.initialize_session_state(
                session_id="test_session",
                app_name="test_app",
                user_id="test_user",
                initial_state=initial_state,
                overwrite_existing=True
            )

            assert result is True
            mock_update.assert_called_once_with(
                session_id="test_session",
                app_name="test_app",
                user_id="test_user",
                state_updates=initial_state  # All keys including existing ones
            )

    # ===== BULK UPDATE USER STATE TESTS =====

    @pytest.mark.asyncio
    async def test_bulk_update_user_state_success(self, manager, mock_session_service):
        """Test bulk updating state for all user sessions."""
        # Set up user sessions
        manager._user_sessions = {
            "test_user": {"app1:session1", "app2:session2"}
        }

        with patch.object(manager, 'update_session_state') as mock_update:
            mock_update.return_value = True

            state_updates = {"bulk_key": "bulk_value"}

            result = await manager.bulk_update_user_state(
                user_id="test_user",
                state_updates=state_updates
            )

            assert result == {"app1:session1": True, "app2:session2": True}
            assert mock_update.call_count == 2

    @pytest.mark.asyncio
    async def test_bulk_update_user_state_with_app_filter(self, manager, mock_session_service):
        """Test bulk updating state with app filter."""
        # Set up user sessions
        manager._user_sessions = {
            "test_user": {"app1:session1", "app2:session2"}
        }

        with patch.object(manager, 'update_session_state') as mock_update:
            mock_update.return_value = True

            state_updates = {"bulk_key": "bulk_value"}

            result = await manager.bulk_update_user_state(
                user_id="test_user",
                state_updates=state_updates,
                app_name_filter="app1"
            )

            assert result == {"app1:session1": True}
            assert mock_update.call_count == 1
            mock_update.assert_called_with(
                session_id="session1",
                app_name="app1",
                user_id="test_user",
                state_updates=state_updates
            )

    @pytest.mark.asyncio
    async def test_bulk_update_user_state_no_sessions(self, manager, mock_session_service):
        """Test bulk updating state when user has no sessions."""
        result = await manager.bulk_update_user_state(
            user_id="nonexistent_user",
            state_updates={"key": "value"}
        )

        assert result == {}

    @pytest.mark.asyncio
    async def test_bulk_update_user_state_mixed_results(self, manager, mock_session_service):
        """Test bulk updating state with mixed success/failure results."""
        # Set up user sessions using a set (to maintain compatibility with implementation)
        # but we'll control the order by using a sorted list for iteration
        from collections import OrderedDict

        # Create an ordered set-like structure
        ordered_sessions = ["app1:session1", "app2:session2"]
        manager._user_sessions = {
            "test_user": set(ordered_sessions)
        }

        with patch.object(manager, 'update_session_state') as mock_update:
            # First call succeeds, second fails
            mock_update.side_effect = [True, False]

            state_updates = {"bulk_key": "bulk_value"}

            result = await manager.bulk_update_user_state(
                user_id="test_user",
                state_updates=state_updates
            )

            # The actual order depends on set iteration, so check both possibilities
            # Either app1 gets True and app2 gets False, or vice versa
            assert len(result) == 2
            assert set(result.values()) == {True, False}  # One succeeded, one failed
            assert mock_update.call_count == 2