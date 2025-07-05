#!/usr/bin/env python
"""Test session deletion functionality."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

from session_manager import SessionLifecycleManager


async def test_session_deletion():
    """Test that session deletion calls delete_session with correct parameters."""
    print("🧪 Testing session deletion...")
    
    # Reset singleton for clean test
    SessionLifecycleManager.reset_instance()
    
    # Create mock session service
    mock_session_service = AsyncMock()
    mock_session_service.get_session = AsyncMock(return_value=None)
    mock_session_service.create_session = AsyncMock(return_value=MagicMock())
    mock_session_service.delete_session = AsyncMock()
    
    # Create session manager with mock service
    session_manager = SessionLifecycleManager.get_instance(
        session_service=mock_session_service,
        auto_cleanup=False
    )
    
    # Create a session
    test_session_id = "test_session_123"
    test_agent_id = "test_agent"
    test_user_id = "test_user"
    
    adk_session = await session_manager.get_or_create_session(
        session_id=test_session_id,
        app_name=test_agent_id,
        user_id=test_user_id,
        initial_state={"test": "data"}
    )
    
    print(f"✅ Created session: {test_session_id}")
    
    # Verify session exists in tracking
    session_key = f"{test_agent_id}:{test_session_id}"
    assert session_key in session_manager._sessions
    print(f"✅ Session tracked: {session_key}")
    
    # Remove the session
    removed = await session_manager.remove_session(session_key)
    
    # Verify removal was successful
    assert removed == True
    print("✅ Session removal returned True")
    
    # Verify session is no longer tracked
    assert session_key not in session_manager._sessions
    print("✅ Session no longer in tracking")
    
    # Verify delete_session was called with correct parameters
    mock_session_service.delete_session.assert_called_once_with(
        session_id=test_session_id,
        app_name=test_agent_id,
        user_id=test_user_id
    )
    print("✅ delete_session called with correct parameters:")
    print(f"   session_id: {test_session_id}")
    print(f"   app_name: {test_agent_id}")
    print(f"   user_id: {test_user_id}")
    
    return True


async def test_session_deletion_error_handling():
    """Test session deletion error handling."""
    print("\n🧪 Testing session deletion error handling...")
    
    # Reset singleton for clean test
    SessionLifecycleManager.reset_instance()
    
    # Create mock session service that raises an error on delete
    mock_session_service = AsyncMock()
    mock_session_service.get_session = AsyncMock(return_value=None)
    mock_session_service.create_session = AsyncMock(return_value=MagicMock())
    mock_session_service.delete_session = AsyncMock(side_effect=Exception("Delete failed"))
    
    # Create session manager with mock service
    session_manager = SessionLifecycleManager.get_instance(
        session_service=mock_session_service,
        auto_cleanup=False
    )
    
    # Create a session
    test_session_id = "test_session_456"
    test_agent_id = "test_agent"
    test_user_id = "test_user"
    
    adk_session = await session_manager.get_or_create_session(
        session_id=test_session_id,
        app_name=test_agent_id,
        user_id=test_user_id,
        initial_state={"test": "data"}
    )
    
    session_key = f"{test_agent_id}:{test_session_id}"
    
    # Remove the session (should handle the delete error gracefully)
    removed = await session_manager.remove_session(session_key)
    
    # Verify removal still succeeded (local tracking removed even if ADK delete failed)
    assert removed == True
    print("✅ Session removal succeeded despite delete_session error")
    
    # Verify session is no longer tracked locally
    assert session_key not in session_manager._sessions
    print("✅ Session still removed from local tracking despite error")
    
    # Verify delete_session was attempted
    mock_session_service.delete_session.assert_called_once()
    print("✅ delete_session was attempted despite error")
    
    return True


async def main():
    """Run all session deletion tests."""
    print("🚀 Testing Session Deletion")
    print("=" * 40)
    
    try:
        test1_passed = await test_session_deletion()
        test2_passed = await test_session_deletion_error_handling()
        
        print(f"\n📊 Test Results:")
        print(f"   Session deletion: {'✅ PASS' if test1_passed else '❌ FAIL'}")
        print(f"   Error handling: {'✅ PASS' if test2_passed else '❌ FAIL'}")
        
        if test1_passed and test2_passed:
            print("\n🎉 All session deletion tests passed!")
            print("💡 Session deletion now works with correct parameters")
            return True
        else:
            print("\n⚠️ Some tests failed")
            return False
            
    except Exception as e:
        print(f"\n❌ Test suite failed with exception: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    import sys
    success = asyncio.run(main())
    sys.exit(0 if success else 1)