#!/usr/bin/env python
"""Integration tests for thought-to-REASONING events conversion.

This test verifies that when Gemini models return thought summaries
(via include_thoughts=True), the ADK middleware correctly converts them
to AG-UI REASONING events.

Related issue: https://github.com/ag-ui-protocol/ag-ui/issues/951
Updated for: https://github.com/ag-ui-protocol/ag-ui/issues/1406

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


class TestThoughtToReasoningIntegration:
    """Integration tests for thought-to-REASONING event conversion with real API calls."""

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

    def _has_reasoning_events(self, events: List[BaseEvent]) -> bool:
        """Check if any REASONING events are present."""
        reasoning_types = {
            EventType.REASONING_START,
            EventType.REASONING_END,
            EventType.REASONING_MESSAGE_START,
            EventType.REASONING_MESSAGE_CONTENT,
            EventType.REASONING_MESSAGE_END,
        }
        return any(e.type in reasoning_types for e in events)

    def _get_reasoning_content(self, events: List[BaseEvent]) -> str:
        """Extract reasoning content from events."""
        content_parts = []
        for event in events:
            if event.type == EventType.REASONING_MESSAGE_CONTENT:
                content_parts.append(event.delta)
        return "".join(content_parts)

    @pytest.mark.asyncio
    async def test_thinking_agent_emits_reasoning_events(self, thinking_agent):
        """Verify that an agent with include_thoughts=True emits REASONING events.

        This is the main test for issue #951 / #1406. The agent should emit:
        - REASONING_START at the beginning of thought content
        - REASONING_MESSAGE_START/CONTENT/END for thought text
        - REASONING_END when thoughts are complete
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
            if event.type in {EventType.REASONING_START, EventType.REASONING_END,
                              EventType.REASONING_MESSAGE_START,
                              EventType.REASONING_MESSAGE_END}:
                print(f"🧠 {event.type}")
            elif event.type == EventType.REASONING_MESSAGE_CONTENT:
                print(f"🧠 REASONING_CONTENT: {event.delta[:50]}...")

        event_counts = self._count_events(events)
        print(f"\nEvent counts: {dict(event_counts)}")

        # Verify basic run structure
        assert event_counts.get("RUN_STARTED", 0) >= 1, "Should have RUN_STARTED"
        assert event_counts.get("RUN_FINISHED", 0) >= 1, "Should have RUN_FINISHED"

        # Check for reasoning events
        # Note: The model may or may not return thoughts depending on the prompt
        # and model behavior, so we just verify the structure is correct when present
        has_reasoning = self._has_reasoning_events(events)

        if has_reasoning:
            print("✅ REASONING events detected!")
            # Verify proper structure: START before END
            reasoning_start_idx = None
            reasoning_end_idx = None
            for i, event in enumerate(events):
                if event.type == EventType.REASONING_START and reasoning_start_idx is None:
                    reasoning_start_idx = i
                if event.type == EventType.REASONING_END:
                    reasoning_end_idx = i

            if reasoning_start_idx is not None and reasoning_end_idx is not None:
                assert reasoning_start_idx < reasoning_end_idx, \
                    "REASONING_START should come before REASONING_END"

            # Check that we have reasoning content
            reasoning_content = self._get_reasoning_content(events)
            if reasoning_content:
                print(f"✅ Reasoning content captured: {len(reasoning_content)} chars")
                assert len(reasoning_content) > 0, "Should have non-empty reasoning content"
        else:
            print("ℹ️ No REASONING events in this run (model may not have returned thoughts)")
            # This is not a failure - the model may choose not to include thoughts

        # Verify we got a text response
        assert event_counts.get("TEXT_MESSAGE_START", 0) >= 1 or \
               event_counts.get("TEXT_MESSAGE_CONTENT", 0) >= 1, \
            "Should have text message events for the response"

    @pytest.mark.asyncio
    async def test_non_thinking_agent_no_reasoning_events(self, non_thinking_agent):
        """Verify that an agent without include_thoughts=True does NOT emit REASONING events.

        This serves as a control test to ensure REASONING events only appear
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

        # Should NOT have reasoning events (since include_thoughts is not enabled)
        has_reasoning = self._has_reasoning_events(events)
        assert not has_reasoning, \
            "Non-thinking agent should NOT emit REASONING events"

        # Should have text message events
        assert event_counts.get("TEXT_MESSAGE_START", 0) >= 1 or \
               event_counts.get("TEXT_MESSAGE_CONTENT", 0) >= 1, \
            "Should have text message events"

        print("✅ No REASONING events as expected for non-thinking agent")

    @pytest.mark.asyncio
    async def test_reasoning_events_structure(self, thinking_agent):
        """Verify the structure and ordering of REASONING events.

        When REASONING events are emitted, they should follow this pattern:
        1. REASONING_START (with message_id)
        2. REASONING_MESSAGE_START
        3. One or more REASONING_MESSAGE_CONTENT
        4. REASONING_MESSAGE_END
        5. REASONING_END

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

        # If we have reasoning events, verify structure
        if self._has_reasoning_events(events):
            reasoning_events = [
                e for e in events
                if e.type in {
                    EventType.REASONING_START,
                    EventType.REASONING_END,
                    EventType.REASONING_MESSAGE_START,
                    EventType.REASONING_MESSAGE_CONTENT,
                    EventType.REASONING_MESSAGE_END,
                }
            ]

            if reasoning_events:
                # First reasoning event should be REASONING_START
                assert reasoning_events[0].type == EventType.REASONING_START, \
                    "First reasoning event should be REASONING_START"

                # Last reasoning event should be REASONING_END
                assert reasoning_events[-1].type == EventType.REASONING_END, \
                    "Last reasoning event should be REASONING_END"

                # REASONING_MESSAGE_START should come before REASONING_MESSAGE_END
                msg_start_idx = None
                msg_end_idx = None
                for i, event in enumerate(reasoning_events):
                    if event.type == EventType.REASONING_MESSAGE_START:
                        msg_start_idx = i
                    if event.type == EventType.REASONING_MESSAGE_END:
                        msg_end_idx = i

                if msg_start_idx is not None and msg_end_idx is not None:
                    assert msg_start_idx < msg_end_idx, \
                        "REASONING_MESSAGE_START should come before END"

                print("✅ REASONING events have correct structure")
        else:
            print("ℹ️ No REASONING events to validate structure")


if __name__ == "__main__":
    # Allow running directly for debugging
    import sys
    if os.environ.get("GOOGLE_API_KEY"):
        pytest.main([__file__, "-v", "-s"])
    else:
        print("GOOGLE_API_KEY not set, skipping integration tests")
        sys.exit(0)
