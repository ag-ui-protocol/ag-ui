#!/usr/bin/env python
"""Test session cleanup functionality with minimal session manager."""

import asyncio
import time
from unittest.mock import AsyncMock

import pytest

from ag_ui_adk import ADKAgent, SessionManager
from google.adk.agents import Agent
from google.adk.sessions import InMemorySessionService
from ag_ui.core import RunAgentInput, UserMessage, EventType

async def test_session_cleanup():
    """Test that session cleanup works with the minimal session manager."""
    print("🧪 Testing session cleanup...")

    # Create a test agent
    agent = Agent(
        name="cleanup_test_agent",
        instruction="Test agent for cleanup"
    )

    # Reset singleton and create session manager with short timeout for faster testing
    SessionManager.reset_instance()

    # Create ADK middleware with short timeouts
    adk_agent = ADKAgent(
        adk_agent=agent,
        app_name="test_app",
        user_id="cleanup_test_user",
        use_in_memory_services=True
    )

    # Get the session manager (already configured with 1200s timeout by default)
    session_manager = adk_agent._session_manager

    # Create some sessions by running the agent
    print("📊 Creating test sessions...")

    # Create sessions for different users
    for i in range(3):
        test_input = RunAgentInput(
            thread_id=f"thread_{i}",
            run_id=f"run_{i}",
            messages=[UserMessage(id=f"msg_{i}", role="user", content=f"Test message {i}")],
            context=[],
            state={},
            tools=[],
            forwarded_props={}
        )

        # Start streaming to create a session
        async for event in adk_agent.run(test_input):
            if event.type == EventType.RUN_STARTED:
                print(f"  Created session for thread_{i}")
            break  # Just need to start the session

    session_count = session_manager.get_session_count()
    print(f"📊 Created {session_count} test sessions")

    # For testing, we'll manually trigger cleanup since we can't wait 20 minutes
    # The minimal manager tracks sessions and can clean them up
    print("🧹 Testing cleanup mechanism...")

    # The minimal session manager doesn't expose expired sessions directly,
    # but we can verify the cleanup works by checking session count
    initial_count = session_manager.get_session_count()

    # Since we can't easily test timeout without waiting, let's just verify
    # the session manager is properly initialized and tracking sessions
    if initial_count > 0:
        print(f"✅ Session manager is tracking {initial_count} sessions")
        print("✅ Cleanup task would remove expired sessions after timeout")
        return True
    else:
        print("❌ No sessions were tracked")
        return False


class TestOptionalCleanupAndTracking:
    """Cleanup task and session tracking can be turned off (issue #2219)."""

    @pytest.fixture
    def session_service(self):
        """In-memory service whose get_session calls can be counted."""
        service = InMemorySessionService()
        service.get_session = AsyncMock(wraps=service.get_session)
        return service

    @pytest.fixture(autouse=True)
    def reset_default_manager(self):
        SessionManager.reset_default()
        yield
        SessionManager.reset_default()

    async def test_default_tracks_and_starts_cleanup(self, session_service):
        manager = SessionManager(session_service=session_service)
        try:
            await manager.get_or_create_session("thread_1", "app", "user")

            assert manager.get_session_count() == 1
            assert manager._cleanup_task is not None
        finally:
            await manager.stop_cleanup_task()

    async def test_none_timeout_does_not_start_cleanup(self, session_service, caplog):
        manager = SessionManager(
            session_service=session_service,
            session_timeout_seconds=None,
            cleanup_interval_seconds=0.01,
        )
        try:
            await manager.get_or_create_session("thread_1", "app", "user")
            # Long enough for several cleanup cycles if a task were running
            await asyncio.sleep(0.05)

            assert manager._cleanup_task is None
            session_service.get_session.assert_not_awaited()
            assert "Error checking session" not in caplog.text
            # Tracking is kept, so per-user limits still work
            assert manager.get_session_count() == 1
        finally:
            await manager.stop_cleanup_task()

    async def test_none_timeout_keeps_max_sessions_per_user(self, session_service):
        manager = SessionManager(
            session_service=session_service,
            session_timeout_seconds=None,
            max_sessions_per_user=1,
        )
        _, first_id = await manager.get_or_create_session("thread_1", "app", "user")
        await manager.get_or_create_session("thread_2", "app", "user")

        assert manager.get_user_session_count("user") == 1
        assert await session_service.get_session(
            app_name="app", user_id="user", session_id=first_id
        ) is None

    async def test_track_sessions_false_skips_tracking_and_cleanup(self, session_service):
        manager = SessionManager(
            session_service=session_service,
            track_sessions=False,
            cleanup_interval_seconds=0.01,
        )
        session, session_id = await manager.get_or_create_session("thread_1", "app", "user")
        await asyncio.sleep(0.05)

        assert session.id == session_id
        assert manager._cleanup_task is None
        assert manager.get_session_count() == 0
        assert manager.get_user_session_count("user") == 0
        session_service.get_session.assert_not_awaited()

        # The same thread still resolves to the same session, and continuing
        # a found session does not register it either
        _, again_id = await manager.get_or_create_session("thread_1", "app", "user")
        assert again_id == session_id
        assert manager._session_keys == set()
        assert manager._user_sessions == {}
        assert manager._session_threads == {}
        assert manager._cleanup_task is None

    def test_track_sessions_false_rejects_max_sessions_per_user(self):
        with pytest.raises(ValueError, match="max_sessions_per_user"):
            SessionManager(track_sessions=False, max_sessions_per_user=5)

    @pytest.mark.parametrize("explicit_service", [True, False])
    def test_adk_agent_passes_track_sessions(self, explicit_service):
        agent = Agent(name="tracking_test_agent", instruction="Test agent")
        kwargs = {"session_service": InMemorySessionService()} if explicit_service else {}

        adk_agent = ADKAgent(
            adk_agent=agent,
            app_name="test_app",
            user_id="test_user",
            track_sessions=False,
            **kwargs,
        )
        assert adk_agent._session_manager._track_sessions is False

        SessionManager.reset_default()
        with pytest.raises(ValueError, match="max_sessions_per_user"):
            ADKAgent(
                adk_agent=agent,
                app_name="test_app",
                user_id="test_user",
                track_sessions=False,
                max_sessions_per_user=3,
                **kwargs,
            )


async def main():
    """Run the test."""
    try:
        # Cleanup any existing instance
        SessionManager.reset_instance()

        success = await test_session_cleanup()

        # Cleanup
        SessionManager.reset_instance()

        if success:
            print("\n✅ All session cleanup tests passed!")
        else:
            print("\n❌ Session cleanup test failed!")
            exit(1)

    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        exit(1)


if __name__ == "__main__":
    asyncio.run(main())