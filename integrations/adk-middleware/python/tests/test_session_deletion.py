#!/usr/bin/env python
"""Test session deletion functionality with minimal session manager."""

import asyncio
from unittest.mock import AsyncMock, MagicMock


from ag_ui_adk import SessionManager

async def test_session_deletion():
    """Test that session deletion calls delete_session with correct parameters."""
    print("🧪 Testing session deletion...")

    # Reset singleton for clean test
    SessionManager.reset_instance()

    # Create mock session service
    mock_session_service = AsyncMock()
    mock_session_service.get_session = AsyncMock(return_value=None)
    mock_session_service.create_session = AsyncMock(return_value=MagicMock())
    mock_session_service.delete_session = AsyncMock()

    # Create session manager with mock service
    session_manager = SessionManager.get_instance(
        session_service=mock_session_service,
        auto_cleanup=False
    )

    # Create a session
    test_session_id = "test_session_123"
    test_app_name = "test_app"
    test_user_id = "test_user"

    adk_session = await session_manager.get_or_create_session(
        session_id=test_session_id,
        app_name=test_app_name,
        user_id=test_user_id,
        initial_state={"test": "data"}
    )

    print(f"✅ Created session: {test_session_id}")

    # Verify session exists in tracking
    session_key = f"{test_app_name}:{test_session_id}"
    assert session_key in session_manager._session_keys
    print(f"✅ Session tracked: {session_key}")

    # Create a mock session object for deletion
    mock_session = MagicMock()
    mock_session.id = test_session_id
    mock_session.app_name = test_app_name
    mock_session.user_id = test_user_id

    # Manually delete the session (internal method)
    await session_manager._delete_session(mock_session)

    # Verify session is no longer tracked
    assert session_key not in session_manager._session_keys
    print("✅ Session no longer in tracking")

    # Verify delete_session was called with correct parameters
    mock_session_service.delete_session.assert_called_once_with(
        session_id=test_session_id,
        app_name=test_app_name,
        user_id=test_user_id
    )
    print("✅ delete_session called with correct parameters:")
    print(f"   session_id: {test_session_id}")
    print(f"   app_name: {test_app_name}")
    print(f"   user_id: {test_user_id}")

    return True


async def test_session_deletion_error_handling():
    """Test session deletion error handling."""
    print("\n🧪 Testing session deletion error handling...")

    # Reset singleton for clean test
    SessionManager.reset_instance()

    # Create mock session service that raises an error on delete
    mock_session_service = AsyncMock()
    mock_session_service.get_session = AsyncMock(return_value=None)
    mock_session_service.create_session = AsyncMock(return_value=MagicMock())
    mock_session_service.delete_session = AsyncMock(side_effect=Exception("Delete failed"))

    # Create session manager with mock service
    session_manager = SessionManager.get_instance(
        session_service=mock_session_service,
        auto_cleanup=False
    )

    # Create a session
    test_session_id = "test_session_456"
    test_app_name = "test_app"
    test_user_id = "test_user"

    await session_manager.get_or_create_session(
        session_id=test_session_id,
        app_name=test_app_name,
        user_id=test_user_id
    )

    session_key = f"{test_app_name}:{test_session_id}"
    assert session_key in session_manager._session_keys

    # Try to delete - should handle the error gracefully
    try:
        await session_manager._delete_session(test_session_id, test_app_name, test_user_id)

        # Even if deletion failed, session should be untracked
        assert session_key not in session_manager._session_keys
        print("✅ Session untracked even after deletion error")

        return True
    except Exception as e:
        print(f"❌ Unexpected exception: {e}")
        return False


async def test_user_session_limits():
    """Test per-user session limits."""
    print("\n🧪 Testing per-user session limits...")

    # Reset singleton for clean test
    SessionManager.reset_instance()

    # Create mock session service
    mock_session_service = AsyncMock()

    # Mock session objects with last_update_time and required attributes
    class MockSession:
        def __init__(self, update_time, session_id=None, app_name=None, user_id=None):
            self.last_update_time = update_time
            self.id = session_id
            self.app_name = app_name
            self.user_id = user_id

    created_sessions = {}

    async def mock_get_session(session_id, app_name, user_id):
        key = f"{app_name}:{session_id}"
        return created_sessions.get(key)

    async def mock_create_session(session_id, app_name, user_id, state):
        import time
        session = MockSession(time.time(), session_id, app_name, user_id)
        key = f"{app_name}:{session_id}"
        created_sessions[key] = session
        return session

    mock_session_service.get_session = mock_get_session
    mock_session_service.create_session = mock_create_session
    mock_session_service.delete_session = AsyncMock()

    # Create session manager with limit of 2 sessions per user
    session_manager = SessionManager.get_instance(
        session_service=mock_session_service,
        max_sessions_per_user=2,
        auto_cleanup=False
    )

    test_user = "limited_user"
    test_app = "test_app"

    # Create 3 sessions for the same user
    for i in range(3):
        await session_manager.get_or_create_session(
            session_id=f"session_{i}",
            app_name=test_app,
            user_id=test_user
        )
        # Small delay to ensure different timestamps
        await asyncio.sleep(0.1)

    # Should only have 2 sessions for this user
    user_count = session_manager.get_user_session_count(test_user)
    assert user_count == 2, f"Expected 2 sessions, got {user_count}"
    print(f"✅ User session limit enforced: {user_count} sessions")

    # Verify the oldest session was removed
    assert f"{test_app}:session_0" not in session_manager._session_keys
    assert f"{test_app}:session_1" in session_manager._session_keys
    assert f"{test_app}:session_2" in session_manager._session_keys
    print("✅ Oldest session was removed")

    return True


async def main():
    """Run all tests."""
    try:
        success = await test_session_deletion()
        success = success and await test_session_deletion_error_handling()
        success = success and await test_user_session_limits()

        if success:
            print("\n✅ All session deletion tests passed!")
        else:
            print("\n❌ Some tests failed!")
            exit(1)

    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        exit(1)


if __name__ == "__main__":
    asyncio.run(main())