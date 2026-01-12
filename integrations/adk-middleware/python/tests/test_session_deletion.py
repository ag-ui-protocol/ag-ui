#!/usr/bin/env python
"""Test session deletion functionality with minimal session manager."""
import pytest

import asyncio
from unittest.mock import AsyncMock, MagicMock


from ag_ui_adk import SessionManager

class TestSessionDeletion:

    @pytest.fixture(
        params=[True, False],
    )
    def save_session_to_memory_on_cleanup(self, request):
        return request.param

    @pytest.fixture
    def mock_memory_service(self):
        """Create a mock memory service."""
        service = AsyncMock()
        service.add_session_to_memory = AsyncMock()
        return service

    """Test session deletion functionality with minimal session manager."""
    async def test_session_deletion(self, mock_memory_service, save_session_to_memory_on_cleanup):
        """Test that session deletion calls delete_session with correct parameters."""
        print("🧪 Testing session deletion...")

        # Reset singleton for clean test
        SessionManager.reset_instance()

        # Create mock session and service
        test_thread_id = "test_thread_123"
        test_backend_session_id = "backend_session_123"  # Backend generates this
        test_app_name = "test_app"
        test_user_id = "test_user"

        # Mock session with state containing thread_id
        created_session = MagicMock()
        created_session.id = test_backend_session_id
        created_session.state = {"_ag_ui_thread_id": test_thread_id, "test": "data"}

        mock_session_service = AsyncMock()
        mock_session_service.list_sessions = AsyncMock(return_value=[])  # No existing sessions
        mock_session_service.create_session = AsyncMock(return_value=created_session)
        mock_session_service.delete_session = AsyncMock()

        # Create session manager with mock service
        session_manager = SessionManager.get_instance(
            session_service=mock_session_service,
            memory_service=mock_memory_service,
            delete_session_on_cleanup=True,
            save_session_to_memory_on_cleanup=save_session_to_memory_on_cleanup
        )

        # Create a session using thread_id (backend generates session_id)
        session, backend_session_id = await session_manager.get_or_create_session(
            thread_id=test_thread_id,
            app_name=test_app_name,
            user_id=test_user_id,
            initial_state={"test": "data"}
        )

        print(f"✅ Created session with thread_id: {test_thread_id}, backend_id: {backend_session_id}")

        # Verify session exists in tracking (uses backend session_id)
        session_key = f"{test_app_name}:{test_backend_session_id}"
        assert session_key in session_manager._session_keys
        print(f"✅ Session tracked: {session_key}")

        # Create a mock session object for deletion
        mock_session = MagicMock()
        mock_session.id = test_backend_session_id
        mock_session.app_name = test_app_name
        mock_session.user_id = test_user_id

        # Manually delete the session (internal method)
        await session_manager._delete_session(mock_session)

        # Verify session is no longer tracked
        assert session_key not in session_manager._session_keys
        print("✅ Session no longer in tracking")

        # Verify delete_session was called with correct parameters
        mock_session_service.delete_session.assert_called_once_with(
            session_id=test_backend_session_id,
            app_name=test_app_name,
            user_id=test_user_id
        )
        print("✅ delete_session called with correct parameters:")
        print(f"   session_id: {test_backend_session_id}")
        print(f"   app_name: {test_app_name}")
        print(f"   user_id: {test_user_id}")

        # Memory service add_session_to_memory should be called based on save_session_to_memory_on_cleanup flag
        if save_session_to_memory_on_cleanup:
            mock_memory_service.add_session_to_memory.assert_called_once()
        else:
            mock_memory_service.add_session_to_memory.assert_not_called()
        return True


    async def test_session_deletion_error_handling(self, mock_memory_service, save_session_to_memory_on_cleanup):
        """Test session deletion error handling."""
        print("\n🧪 Testing session deletion error handling...")

        # Reset singleton for clean test
        SessionManager.reset_instance()

        # Create mock session and service
        test_thread_id = "test_thread_456"
        test_backend_session_id = "backend_session_456"
        test_app_name = "test_app"
        test_user_id = "test_user"

        created_session = MagicMock()
        created_session.id = test_backend_session_id
        created_session.state = {"_ag_ui_thread_id": test_thread_id}

        mock_session_service = AsyncMock()
        mock_session_service.list_sessions = AsyncMock(return_value=[])
        mock_session_service.create_session = AsyncMock(return_value=created_session)
        mock_session_service.delete_session = AsyncMock(side_effect=Exception("Delete failed"))

        # Create session manager with mock service
        session_manager = SessionManager.get_instance(
            session_service=mock_session_service,
            memory_service=mock_memory_service,
            delete_session_on_cleanup=False,
            save_session_to_memory_on_cleanup=save_session_to_memory_on_cleanup
        )

        # Create a session
        await session_manager.get_or_create_session(
            thread_id=test_thread_id,
            app_name=test_app_name,
            user_id=test_user_id
        )

        session_key = f"{test_app_name}:{test_backend_session_id}"
        assert session_key in session_manager._session_keys

        # Create mock session object for deletion
        mock_session = MagicMock()
        mock_session.id = test_backend_session_id
        mock_session.app_name = test_app_name
        mock_session.user_id = test_user_id

        # Try to delete - should handle the error gracefully
        await session_manager._delete_session(mock_session)

        # Even if deletion failed, session should be untracked
        assert session_key not in session_manager._session_keys
        print("✅ Session untracked even after deletion error")

        # Memory service add_session_to_memory should be called based on save_session_to_memory_on_cleanup flag
        if save_session_to_memory_on_cleanup:
            mock_memory_service.add_session_to_memory.assert_called_once()
        else:
            mock_memory_service.add_session_to_memory.assert_not_called()




    async def test_user_session_limits(self, mock_memory_service, save_session_to_memory_on_cleanup):
        """Test per-user session limits."""
        print("\n🧪 Testing per-user session limits...")

        # Reset singleton for clean test
        SessionManager.reset_instance()

        import time
        import uuid

        # Create mock session service
        mock_session_service = AsyncMock()

        # Mock session objects with last_update_time and required attributes
        class MockSession:
            def __init__(self, update_time, session_id=None, app_name=None, user_id=None, state=None):
                self.last_update_time = update_time
                self.id = session_id
                self.app_name = app_name
                self.user_id = user_id
                self.state = state or {}

        created_sessions = {}

        async def mock_list_sessions(app_name, user_id):
            # Return sessions that match app_name/user_id
            return [s for s in created_sessions.values()
                    if s.app_name == app_name and s.user_id == user_id]

        async def mock_get_session(session_id, app_name, user_id):
            key = f"{app_name}:{session_id}"
            return created_sessions.get(key)

        async def mock_create_session(app_name, user_id, state):
            # Backend generates session_id
            session_id = str(uuid.uuid4())
            session = MockSession(time.time(), session_id, app_name, user_id, state)
            key = f"{app_name}:{session_id}"
            created_sessions[key] = session
            return session

        mock_session_service.list_sessions = mock_list_sessions
        mock_session_service.get_session = mock_get_session
        mock_session_service.create_session = mock_create_session
        mock_session_service.delete_session = AsyncMock()

        # Create session manager with limit of 2 sessions per user
        session_manager = SessionManager.get_instance(
            session_service=mock_session_service,
            memory_service=mock_memory_service,
            max_sessions_per_user=2,
            delete_session_on_cleanup=False,
            save_session_to_memory_on_cleanup=save_session_to_memory_on_cleanup
        )

        test_user = "limited_user"
        test_app = "test_app"

        # Create 3 sessions for the same user (using different thread_ids)
        for i in range(3):
            await session_manager.get_or_create_session(
                thread_id=f"thread_{i}",
                app_name=test_app,
                user_id=test_user
            )
            # Small delay to ensure different timestamps
            await asyncio.sleep(0.1)

        # Should only have 2 sessions for this user
        user_count = session_manager.get_user_session_count(test_user)
        assert user_count == 2, f"Expected 2 sessions, got {user_count}"
        print(f"✅ User session limit enforced: {user_count} sessions")

        # Verify we have exactly 2 session keys (session IDs are now UUIDs)
        app_session_keys = [k for k in session_manager._session_keys if k.startswith(f"{test_app}:")]
        assert len(app_session_keys) == 2, f"Expected 2 session keys, got {len(app_session_keys)}"
        print("✅ Oldest session was removed")

        # Memory service add_session_to_memory should be called based on save_session_to_memory_on_cleanup flag
        if save_session_to_memory_on_cleanup:
            mock_memory_service.add_session_to_memory.assert_called_once()
        else:
            mock_memory_service.add_session_to_memory.assert_not_called()

        return True

