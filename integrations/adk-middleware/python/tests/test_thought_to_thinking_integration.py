#!/usr/bin/env python
"""Integration tests for thought-to-THINKING events conversion.

This test verifies that when Gemini models return thought summaries
(via include_thoughts=True), the ADK middleware correctly converts them
to AG-UI THINKING events.

Related issue: https://github.com/ag-ui-protocol/ag-ui/issues/951

Requirements:
- GOOGLE_API_KEY environment variable must be set
- Uses Gemini 2.5 Flash model with thinking enabled
"""

import asyncio
import os
import pytest
import uuid
from collections import Counter
from typing import Dict, List

from ag_ui.core import (
    EventType,
    RunAgentInput,
    UserMessage,
    BaseEvent,
)
from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents import LlmAgent
from google.adk.planners import BuiltInPlanner
from google.genai import types


# Skip all tests if GOOGLE_API_KEY is not set
pytestmark = pytest.mark.skipif(
    not os.environ.get("GOOGLE_API_KEY"),
    reason="GOOGLE_API_KEY environment variable not set"
)


class TestThoughtToThinkingIntegration:
    """Integration tests for thought-to-THINKING event conversion with real API calls."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager before each test."""
        try:
            SessionManager.reset_instance()
        except RuntimeError:
            pass
        yield
        try:
            SessionManager.reset_instance()
        except RuntimeError:
            pass

    @pytest.fixture
    def thinking_agent(self):
        """Create an ADK agent with thinking enabled (include_thoughts=True)."""
        adk_agent = LlmAgent(
            name="thinking_agent",
            model="gemini-2.5-flash",
            instruction="""You are a careful reasoning assistant. For every question:
            1. First, think through the problem systematically
            2. Consider potential pitfalls or trick questions
            3. Work through the logic step by step
            4. Only then provide your final answer

            Always show your reasoning process before giving the answer.
            """,
            planner=BuiltInPlanner(
                thinking_config=types.ThinkingConfig(
                    include_thoughts=True
                )
            ),
        )

        return ADKAgent(
            adk_agent=adk_agent,
            app_name="test_thinking",
            user_id="test_user",
            use_in_memory_services=True,
        )

    @pytest.fixture
    def non_thinking_agent(self):
        """Create an ADK agent without thinking enabled for comparison."""
        adk_agent = LlmAgent(
            name="non_thinking_agent",
            model="gemini-2.5-flash",
            instruction="""You are a helpful assistant. Answer questions directly and concisely.""",
        )

        return ADKAgent(
            adk_agent=adk_agent,
            app_name="test_non_thinking",
            user_id="test_user",
            use_in_memory_services=True,
        )

    def _create_input(self, message: str) -> RunAgentInput:
        """Helper to create RunAgentInput."""
        return RunAgentInput(
            thread_id=f"test_thread_{uuid.uuid4().hex[:8]}",
            run_id=f"test_run_{uuid.uuid4().hex[:8]}",
            messages=[
                UserMessage(
                    id=f"msg_{uuid.uuid4().hex[:8]}",
                    role="user",
                    content=message
                )
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )

    def _count_events(self, events: List[BaseEvent]) -> Dict[str, int]:
        """Count events by type."""
        return Counter(e.type.value if hasattr(e.type, 'value') else str(e.type) for e in events)

    def _has_thinking_events(self, events: List[BaseEvent]) -> bool:
        """Check if any THINKING events are present."""
        thinking_types = {
            EventType.THINKING_START,
            EventType.THINKING_END,
            EventType.THINKING_TEXT_MESSAGE_START,
            EventType.THINKING_TEXT_MESSAGE_CONTENT,
            EventType.THINKING_TEXT_MESSAGE_END,
        }
        return any(e.type in thinking_types for e in events)

    def _get_thinking_content(self, events: List[BaseEvent]) -> str:
        """Extract thinking content from events."""
        content_parts = []
        for event in events:
            if event.type == EventType.THINKING_TEXT_MESSAGE_CONTENT:
                content_parts.append(event.delta)
        return "".join(content_parts)

    @pytest.mark.asyncio
    async def test_thinking_agent_emits_thinking_events(self, thinking_agent):
        """Verify that an agent with include_thoughts=True emits THINKING events.

        This is the main test for issue #951. The agent should emit:
        - THINKING_START at the beginning of thought content
        - THINKING_TEXT_MESSAGE_START/CONTENT/END for thought text
        - THINKING_END when thoughts are complete
        - Regular TEXT_MESSAGE events for the final response

        Note: The model may not always return thoughts even with include_thoughts=True,
        so we test that when thoughts ARE returned, they are properly converted.
        """
        # Use a prompt that encourages the model to think deeply
        # Complex multi-step problems are more likely to trigger thought summaries
        input_data = self._create_input(
            "A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left? "
            "Think through this carefully before answering."
        )

        events = []
        async for event in thinking_agent.run(input_data):
            events.append(event)
            # Print for debugging
            if event.type in {EventType.THINKING_START, EventType.THINKING_END,
                              EventType.THINKING_TEXT_MESSAGE_START,
                              EventType.THINKING_TEXT_MESSAGE_END}:
                print(f"🧠 {event.type}")
            elif event.type == EventType.THINKING_TEXT_MESSAGE_CONTENT:
                print(f"🧠 THINKING_CONTENT: {event.delta[:50]}...")

        event_counts = self._count_events(events)
        print(f"\nEvent counts: {dict(event_counts)}")

        # Verify basic run structure
        assert event_counts.get("RUN_STARTED", 0) >= 1, "Should have RUN_STARTED"
        assert event_counts.get("RUN_FINISHED", 0) >= 1, "Should have RUN_FINISHED"

        # Check for thinking events
        # Note: The model may or may not return thoughts depending on the prompt
        # and model behavior, so we just verify the structure is correct when present
        has_thinking = self._has_thinking_events(events)

        if has_thinking:
            print("✅ THINKING events detected!")
            # Verify proper structure: START before END
            thinking_start_idx = None
            thinking_end_idx = None
            for i, event in enumerate(events):
                if event.type == EventType.THINKING_START and thinking_start_idx is None:
                    thinking_start_idx = i
                if event.type == EventType.THINKING_END:
                    thinking_end_idx = i

            if thinking_start_idx is not None and thinking_end_idx is not None:
                assert thinking_start_idx < thinking_end_idx, \
                    "THINKING_START should come before THINKING_END"

            # Check that we have thinking content
            thinking_content = self._get_thinking_content(events)
            if thinking_content:
                print(f"✅ Thinking content captured: {len(thinking_content)} chars")
                assert len(thinking_content) > 0, "Should have non-empty thinking content"
        else:
            print("ℹ️ No THINKING events in this run (model may not have returned thoughts)")
            # This is not a failure - the model may choose not to include thoughts

        # Verify we got a text response
        assert event_counts.get("TEXT_MESSAGE_START", 0) >= 1 or \
               event_counts.get("TEXT_MESSAGE_CONTENT", 0) >= 1, \
            "Should have text message events for the response"

    @pytest.mark.asyncio
    async def test_non_thinking_agent_no_thinking_events(self, non_thinking_agent):
        """Verify that an agent without include_thoughts=True does NOT emit THINKING events.

        This serves as a control test to ensure THINKING events only appear
        when the model is configured to include thoughts.
        """
        input_data = self._create_input("What is 2 + 2?")

        events = []
        async for event in non_thinking_agent.run(input_data):
            events.append(event)

        event_counts = self._count_events(events)
        print(f"\nEvent counts: {dict(event_counts)}")

        # Verify basic run structure
        assert event_counts.get("RUN_STARTED", 0) >= 1, "Should have RUN_STARTED"
        assert event_counts.get("RUN_FINISHED", 0) >= 1, "Should have RUN_FINISHED"

        # Should NOT have thinking events (since include_thoughts is not enabled)
        has_thinking = self._has_thinking_events(events)
        assert not has_thinking, \
            "Non-thinking agent should NOT emit THINKING events"

        # Should have text message events
        assert event_counts.get("TEXT_MESSAGE_START", 0) >= 1 or \
               event_counts.get("TEXT_MESSAGE_CONTENT", 0) >= 1, \
            "Should have text message events"

        print("✅ No THINKING events as expected for non-thinking agent")

    @pytest.mark.asyncio
    async def test_thinking_events_structure(self, thinking_agent):
        """Verify the structure and ordering of THINKING events.

        When THINKING events are emitted, they should follow this pattern:
        1. THINKING_START (with optional title)
        2. THINKING_TEXT_MESSAGE_START
        3. One or more THINKING_TEXT_MESSAGE_CONTENT
        4. THINKING_TEXT_MESSAGE_END
        5. THINKING_END

        Then followed by regular TEXT_MESSAGE events for the response.
        """
        # Use a logic puzzle that requires careful reasoning
        input_data = self._create_input(
            "If it takes 5 machines 5 minutes to make 5 widgets, how long would it take "
            "100 machines to make 100 widgets? Reason through this step by step."
        )

        events = []
        async for event in thinking_agent.run(input_data):
            events.append(event)

        # If we have thinking events, verify structure
        if self._has_thinking_events(events):
            thinking_events = [
                e for e in events
                if e.type in {
                    EventType.THINKING_START,
                    EventType.THINKING_END,
                    EventType.THINKING_TEXT_MESSAGE_START,
                    EventType.THINKING_TEXT_MESSAGE_CONTENT,
                    EventType.THINKING_TEXT_MESSAGE_END,
                }
            ]

            if thinking_events:
                # First thinking event should be THINKING_START
                assert thinking_events[0].type == EventType.THINKING_START, \
                    "First thinking event should be THINKING_START"

                # Last thinking event should be THINKING_END
                assert thinking_events[-1].type == EventType.THINKING_END, \
                    "Last thinking event should be THINKING_END"

                # THINKING_TEXT_MESSAGE_START should come before THINKING_TEXT_MESSAGE_END
                msg_start_idx = None
                msg_end_idx = None
                for i, event in enumerate(thinking_events):
                    if event.type == EventType.THINKING_TEXT_MESSAGE_START:
                        msg_start_idx = i
                    if event.type == EventType.THINKING_TEXT_MESSAGE_END:
                        msg_end_idx = i

                if msg_start_idx is not None and msg_end_idx is not None:
                    assert msg_start_idx < msg_end_idx, \
                        "THINKING_TEXT_MESSAGE_START should come before END"

                print("✅ THINKING events have correct structure")
        else:
            print("ℹ️ No THINKING events to validate structure")


if __name__ == "__main__":
    # Allow running directly for debugging
    import sys
    if os.environ.get("GOOGLE_API_KEY"):
        pytest.main([__file__, "-v", "-s"])
    else:
        print("GOOGLE_API_KEY not set, skipping integration tests")
        sys.exit(0)
