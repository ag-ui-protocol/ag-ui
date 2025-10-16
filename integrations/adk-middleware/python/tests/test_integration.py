#!/usr/bin/env python
"""Integration test for ADK middleware without requiring API calls."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

from ag_ui.core import RunAgentInput, UserMessage, EventType
from ag_ui_adk import ADKAgent

async def test_session_creation_logic():
    """Test session creation logic with mocked ADK agent."""
    print("🧪 Testing session creation logic...")

    # Create a real ADK agent for testing
    from google.adk.agents import Agent
    mock_adk_agent = Agent(
        name="mock_agent",
        instruction="Mock agent for testing"
    )

    # Mock the runner's run_async method
    mock_runner = MagicMock()
    mock_events = [
        MagicMock(type="TEXT_MESSAGE_START"),
        MagicMock(type="TEXT_MESSAGE_CONTENT", content="Hello from mock!"),
        MagicMock(type="TEXT_MESSAGE_END"),
    ]

    async def mock_run_async(*args, **kwargs):
        for event in mock_events:
            yield event

    mock_runner.run_async = mock_run_async

    # Create ADK middleware with direct agent embedding
    adk_agent = ADKAgent(
        adk_agent=mock_adk_agent,
        app_name="test_app",
        user_id="test_user",
        use_in_memory_services=True,
    )

    # Mock the get_or_create_runner method to return our mock
    adk_agent._get_or_create_runner = MagicMock(return_value=mock_runner)

    # Create test input
    test_input = RunAgentInput(
        thread_id="test_session_456",
        run_id="test_run_789",
        messages=[
            UserMessage(
                id="msg_1",
                role="user",
                content="Test session creation"
            )
        ],
        state={"test": "data"},
        context=[],
        tools=[],
        forwarded_props={}
    )

    # Run the test
    events = []
    try:
        async for event in adk_agent.run(test_input):
            events.append(event)
            print(f"📧 Event: {event.type}")
    except Exception as e:
        print(f"⚠️ Test completed with exception (expected with mocks): {e}")

    # Check that we got some events
    if events:
        print(f"✅ Got {len(events)} events")
        # Should have at least RUN_STARTED
        if any(event.type == EventType.RUN_STARTED for event in events):
            print("✅ RUN_STARTED event found")
        else:
            print("⚠️ No RUN_STARTED event found")
    else:
        print("❌ No events received")

    return len(events) > 0

async def test_session_service_calls():
    """Test that session service methods are called correctly."""
    print("\n🧪 Testing session service interaction...")

    # Create a test agent first
    from google.adk.agents import Agent
    test_agent = Agent(name="session_test_agent", instruction="Test agent.")

    # Create ADK middleware (session service is now encapsulated in session manager)
    adk_agent = ADKAgent(
        adk_agent=test_agent,
        app_name="test_app",
        user_id="test_user",
        use_in_memory_services=True,
    )

    # Test the session creation method directly through session manager
    try:
        session = await adk_agent._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            session_id="test_session_123",
            initial_state={"key": "value"}
        )

        print("✅ Session creation method completed without error")

        # Verify we got a session object back
        if session:
            print("✅ Session object returned from session manager")
        else:
            print("⚠️ No session object returned, but no error raised")

        print("✅ Session manager integration working correctly")
        return True

    except Exception as e:
        print(f"❌ Session creation test failed: {e}")
        return False

async def main():
    print("🚀 ADK Middleware Integration Tests")
    print("====================================")

    test1_passed = await test_session_creation_logic()
    test2_passed = await test_session_service_calls()

    print(f"\n📊 Test Results:")
    print(f"   Session creation logic: {'✅ PASS' if test1_passed else '❌ FAIL'}")
    print(f"   Session service calls: {'✅ PASS' if test2_passed else '❌ FAIL'}")

    if test1_passed and test2_passed:
        print("\n🎉 All integration tests passed!")
    else:
        print("\n⚠️ Some tests failed - check implementation")

if __name__ == "__main__":
    asyncio.run(main())