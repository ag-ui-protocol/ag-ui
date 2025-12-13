"""Optional real API tests for Claude Agent SDK integration.

These tests require authentication credentials (ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY).
Skip if not available.
"""

import pytest
import os

from ag_ui_claude import ClaudeAgent
from ag_ui.core import RunAgentInput, UserMessage


def has_auth_credentials():
    """Check if any authentication credentials are available."""
    return bool(os.getenv("ANTHROPIC_AUTH_TOKEN") or os.getenv("ANTHROPIC_API_KEY"))


@pytest.mark.skipif(
    not has_auth_credentials(),
    reason="No authentication credentials found (ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY) - skipping real API tests"
)
class TestRealAPI:
    """Real API integration tests (optional)."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager."""
        from ag_ui_claude.session_manager import SessionManager
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def claude_agent(self):
        """Create ClaudeAgent with real API."""
        return ClaudeAgent(
            use_persistent_sessions=False,  # Use stateless for simpler testing
            app_name="test_app",
            user_id="test_user"
        )

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_real_api_basic_conversation(self, claude_agent):
        """Test basic conversation with real API."""
        input_data = RunAgentInput(
            thread_id="test_thread_real",
            run_id="test_run_real",
            messages=[
                UserMessage(
                    id="msg_1",
                    role="user",
                    content="Say hello in exactly 3 words."
                )
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )
        
        events = []
        try:
            async for event in claude_agent.run(input_data):
                events.append(event)
                print(f"Event: {event.type}")
        except Exception as e:
            pytest.fail(f"Real API test failed: {e}")
        
        # Should have events
        assert len(events) > 0
        
        # Should have RUN_STARTED and RUN_FINISHED
        event_types = [e.type for e in events]
        assert "RUN_STARTED" in str(event_types)
        assert "RUN_FINISHED" in str(event_types)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_real_api_with_system_message(self, claude_agent):
        """Test with system message."""
        from ag_ui.core import SystemMessage
        
        input_data = RunAgentInput(
            thread_id="test_thread_system",
            run_id="test_run_system",
            messages=[
                SystemMessage(id="sys_msg_1", content="You are a helpful assistant."),
                UserMessage(
                    id="msg_1",
                    role="user",
                    content="What is 2+2?"
                )
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )
        
        events = []
        try:
            async for event in claude_agent.run(input_data):
                events.append(event)
        except Exception as e:
            pytest.fail(f"Real API test with system message failed: {e}")
        
        assert len(events) > 0

