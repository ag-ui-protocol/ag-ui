#!/usr/bin/env python
"""Test session deletion functionality with minimal session manager."""
import pytest
from types import SimpleNamespace

import asyncio
import logging
from unittest.mock import AsyncMock, MagicMock


from ag_ui_adk import SessionManager

class TestSessionDeletion:

    @pytest.fixture(
        params=[True, False],
    )
    def save_session_to_memory_on_cleanup(self, request):
        return request.param

    @pytest.fixture(
        params=[True, False],
    )
    def mock_memory_service(self, request):
        """Create a mock memory service."""
        if request.param is False:
            return None
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
        mock_session_service.list_sessions = AsyncMock(return_value=SimpleNamespace(sessions=[]))  # No existing sessions
        mock_session_service.get_session = AsyncMock(return_value=None)
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
        session_key = (test_app_name, test_user_id, test_backend_session_id)
        assert session_key in session_manager._session_keys
        print(f"✅ Session tracked: {session_key}")

        # Create a mock session object for deletion
        mock_session = MagicMock()
        mock_session.id = test_backend_session_id
        mock_session.app_name = test_app_name
        mock_session.user_id = test_user_id
        mock_session.state = created_session.state

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

        if mock_memory_service is not None:
        # Memory service add_session_to_memory should be called based on save_session_to_memory_on_cleanup flag
            if save_session_to_memory_on_cleanup:
                mock_memory_service.add_session_to_memory.assert_called_once()
            else:
                mock_memory_service.add_session_to_memory.assert_not_called()
        return True


    async def test_session_deletion_error_handling(
        self, mock_memory_service, save_session_to_memory_on_cleanup, caplog
    ):
        """A failing backend delete is logged, not raised, and still untracks."""
        SessionManager.reset_instance()

        test_thread_id = "test_thread_456"
        test_backend_session_id = "backend_session_456"
        test_app_name = "test_app"
        test_user_id = "test_user"

        created_session = MagicMock()
        created_session.id = test_backend_session_id
        created_session.app_name = test_app_name
        created_session.user_id = test_user_id
        created_session.state = {"_ag_ui_thread_id": test_thread_id}

        mock_session_service = AsyncMock()
        mock_session_service.list_sessions = AsyncMock(return_value=SimpleNamespace(sessions=[]))
        mock_session_service.get_session = AsyncMock(return_value=None)
        mock_session_service.create_session = AsyncMock(return_value=created_session)
        mock_session_service.delete_session = AsyncMock(side_effect=Exception("Delete failed"))

        session_manager = SessionManager.get_instance(
            session_service=mock_session_service,
            memory_service=mock_memory_service,
            delete_session_on_cleanup=True,
            save_session_to_memory_on_cleanup=save_session_to_memory_on_cleanup
        )

        session, _ = await session_manager.get_or_create_session(
            thread_id=test_thread_id,
            app_name=test_app_name,
            user_id=test_user_id
        )
        mock_session_service.create_session.assert_awaited_once()

        session_key = (test_app_name, test_user_id, test_backend_session_id)
        assert session_key in session_manager._session_keys
        assert session_manager.get_user_session_count(test_user_id) == 1

        # Must not raise: the backend error is handled inside _delete_session.
        with caplog.at_level(logging.ERROR, logger="ag_ui_adk.session_manager"):
            await session_manager._delete_session(session)

        mock_session_service.delete_session.assert_awaited_once_with(
            session_id=test_backend_session_id,
            app_name=test_app_name,
            user_id=test_user_id
        )
        assert any(
            record.levelno == logging.ERROR
            and "Failed to delete session" in record.getMessage()
            and "Delete failed" in record.getMessage()
            for record in caplog.records
        )

        # Even though the backend delete failed, the session is untracked.
        assert session_key not in session_manager._session_keys
        assert test_user_id not in session_manager._user_sessions
        assert session_manager.get_session_count() == 0

        if mock_memory_service is not None:
            if save_session_to_memory_on_cleanup:
                mock_memory_service.add_session_to_memory.assert_awaited_once_with(session)
            else:
                mock_memory_service.add_session_to_memory.assert_not_called()

    async def test_session_not_created_by_middleware_is_not_deleted(self):
        """A session continued by native ID is never tracked, evicted, or deleted."""
        SessionManager.reset_instance()

        native_session_id = "native_session_789"
        test_app_name = "test_app"
        test_user_id = "test_user"

        # The caller's own session: no _ag_ui_thread_id stamp.
        native_session = SimpleNamespace(
            id=native_session_id,
            app_name=test_app_name,
            user_id=test_user_id,
            state={"caller": "data"},
            last_update_time=0.0,
        )
        store = {native_session_id: native_session}
        clock = iter(range(1, 100))

        async def get_session(session_id, app_name, user_id):
            return store.get(session_id)

        async def list_sessions(app_name, user_id):
            return SimpleNamespace(sessions=list(store.values()))

        async def create_session(user_id, app_name, state, session_id=None):
            tick = next(clock)
            session = SimpleNamespace(
                id=session_id or f"created_{tick}",
                app_name=app_name,
                user_id=user_id,
                state=dict(state),
                last_update_time=float(tick),
            )
            store[session.id] = session
            return session

        async def delete_session(session_id, app_name, user_id):
            store.pop(session_id, None)

        mock_session_service = AsyncMock()
        mock_session_service.get_session = AsyncMock(side_effect=get_session)
        mock_session_service.list_sessions = AsyncMock(side_effect=list_sessions)
        mock_session_service.create_session = AsyncMock(side_effect=create_session)
        mock_session_service.delete_session = AsyncMock(side_effect=delete_session)

        session_manager = SessionManager.get_instance(
            session_service=mock_session_service,
            delete_session_on_cleanup=True,
            max_sessions_per_user=1,
        )

        try:
            session, backend_session_id = await session_manager.get_or_create_session(
                thread_id=native_session_id,
                app_name=test_app_name,
                user_id=test_user_id
            )
            assert session is native_session
            assert backend_session_id == native_session_id
            mock_session_service.create_session.assert_not_called()

            # Adopted, not created here: never tracked.
            native_key = (test_app_name, test_user_id, native_session_id)
            assert native_key not in session_manager._session_keys
            assert session_manager.get_session_count() == 0
            assert session_manager.get_user_session_count(test_user_id) == 0

            # The deletion path leaves the caller's session in its store.
            await session_manager._delete_session(session)
            mock_session_service.delete_session.assert_not_called()
            assert store[native_session_id] is native_session

            # Two new threads at max_sessions_per_user=1: the second evicts the
            # first created session, and eviction never reaches the adopted one.
            first, first_id = await session_manager.get_or_create_session(
                thread_id="new_thread_1", app_name=test_app_name, user_id=test_user_id
            )
            second, second_id = await session_manager.get_or_create_session(
                thread_id="new_thread_2", app_name=test_app_name, user_id=test_user_id
            )
            assert native_session_id not in (first_id, second_id)
            mock_session_service.delete_session.assert_awaited_once_with(
                session_id=first_id, app_name=test_app_name, user_id=test_user_id
            )
            assert store[native_session_id] is native_session
            assert first_id not in store
            assert session_manager._session_keys == {
                (test_app_name, test_user_id, second_id)
            }
        finally:
            await session_manager.stop_cleanup_task()
            SessionManager.reset_instance()

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
            return SimpleNamespace(sessions=[s for s in created_sessions.values()
                    if s.app_name == app_name and s.user_id == user_id])

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
        app_session_keys = [k for k in session_manager._session_keys if k[0] == test_app]
        assert len(app_session_keys) == 2, f"Expected 2 session keys, got {len(app_session_keys)}"
        print("✅ Oldest session was removed")

        # Sessions the middleware created are still deleted from the backend.
        oldest = next(
            s for s in created_sessions.values()
            if s.state["_ag_ui_thread_id"] == "thread_0"
        )
        mock_session_service.delete_session.assert_called_once_with(
            session_id=oldest.id, app_name=test_app, user_id=test_user
        )

        if mock_memory_service is not None:
            # Memory service add_session_to_memory should be called based on save_session_to_memory_on_cleanup flag
            if save_session_to_memory_on_cleanup:
                mock_memory_service.add_session_to_memory.assert_called_once()
            else:
                mock_memory_service.add_session_to_memory.assert_not_called()

        return True

