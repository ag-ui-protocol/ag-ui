#!/usr/bin/env python3
"""Test session cleanup functionality to ensure no subscriptable errors."""

import asyncio
import time

from adk_agent import ADKAgent
from agent_registry import AgentRegistry
from session_manager import SessionLifecycleManager
from google.adk.agents import Agent

async def test_session_cleanup():
    """Test that session cleanup works without 'SessionInfo' subscriptable errors."""
    print("🧪 Testing session cleanup...")
    
    # Create a test agent
    agent = Agent(
        name="cleanup_test_agent",
        instruction="Test agent for cleanup"
    )
    
    registry = AgentRegistry.get_instance()
    registry.clear()
    registry.set_default_agent(agent)
    
    # Reset singleton and create session manager with short timeout for faster testing
    from session_manager import SessionLifecycleManager
    SessionLifecycleManager.reset_instance()  # Reset singleton for testing
    
    session_manager = SessionLifecycleManager.get_instance(
        session_timeout_seconds=1,  # 1 second timeout for quick testing
        cleanup_interval_seconds=1,  # 1 second cleanup interval
        auto_cleanup=False  # We'll manually trigger cleanup
    )
    
    # Create ADK middleware (will use the singleton session manager)
    adk_agent = ADKAgent(
        app_name="test_app",
        user_id="cleanup_test_user",
        use_in_memory_services=True
    )
    
    # Manually add some session data to the session manager
    session_manager = adk_agent._session_manager
    
    # Track some sessions
    session_manager.track_activity("test_session_1", "test_app", "user1", "thread1")
    session_manager.track_activity("test_session_2", "test_app", "user2", "thread2")
    session_manager.track_activity("test_session_3", "test_app", "user1", "thread3")
    
    print(f"📊 Created {len(session_manager._sessions)} test sessions")
    
    # Wait a bit to let sessions expire
    await asyncio.sleep(1.1)
    
    # Check that sessions are now expired
    expired_sessions = session_manager.get_expired_sessions()
    print(f"⏰ Found {len(expired_sessions)} expired sessions")
    
    # Test the cleanup by manually removing expired sessions
    try:
        # Test removing expired sessions one by one
        for session_info in expired_sessions:
            session_key = session_info["session_key"]
            removed = await session_manager.remove_session(session_key)
            if not removed:
                print(f"⚠️ Failed to remove session: {session_key}")
        
        print("✅ Session cleanup completed without errors")
        return True
    except TypeError as e:
        if "not subscriptable" in str(e):
            print(f"❌ SessionInfo subscriptable error: {e}")
            return False
        else:
            print(f"❌ Other TypeError: {e}")
            return False
    except Exception as e:
        print(f"❌ Unexpected error during cleanup: {e}")
        return False

async def test_session_info_access():
    """Test accessing SessionInfo attributes vs dictionary access."""
    print("\n🧪 Testing SessionInfo attribute access...")
    
    # Reset and create a fresh session manager for this test
    SessionLifecycleManager.reset_instance()  # Reset singleton for testing
    session_manager = SessionLifecycleManager.get_instance(
        session_timeout_seconds=10,  # Long timeout to prevent expiration during test
        cleanup_interval_seconds=1
    )
    
    # Track a session
    session_manager.track_activity("test_key_2", "test_app2", "user2", "thread2")
    
    # Get session info objects immediately (sessions should exist)
    session_info_objects = list(session_manager._sessions.values())
    if session_info_objects:
        session_obj = session_info_objects[0]  # This should be a SessionInfo object
        print(f"✅ Session object (attr): app_name={session_obj.app_name}")
        print("✅ SessionInfo attribute access working correctly")
        return True
    
    print("❌ No sessions found for testing")
    return False

async def main():
    print("🚀 Testing Session Cleanup Fix")
    print("==============================")
    
    test1_passed = await test_session_cleanup()
    test2_passed = await test_session_info_access()
    
    print(f"\n📊 Test Results:")
    print(f"   Session cleanup: {'✅ PASS' if test1_passed else '❌ FAIL'}")
    print(f"   SessionInfo access: {'✅ PASS' if test2_passed else '❌ FAIL'}")
    
    if test1_passed and test2_passed:
        print("\n🎉 All session cleanup tests passed!")
        print("💡 The 'SessionInfo' subscriptable error should be fixed!")
    else:
        print("\n⚠️ Some tests failed - check implementation")

if __name__ == "__main__":
    asyncio.run(main())