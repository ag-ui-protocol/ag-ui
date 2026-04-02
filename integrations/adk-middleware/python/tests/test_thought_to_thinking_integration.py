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

    @pytest.mark.asyncio
    async def test_reasoning_message_id_consistency(self, thinking_agent):
        """Verify that all reasoning events in a block share the same message_id.

        REASONING_START, REASONING_MESSAGE_START, REASONING_MESSAGE_CONTENT,
        REASONING_MESSAGE_END, and REASONING_END should all carry the same
        message_id so the client can correlate them.
        """
        input_data = self._create_input(
            "What is the sum of the first 10 prime numbers? "
            "Show your work step by step."
        )

        events = []
        async for event in thinking_agent.run(input_data):
            events.append(event)

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

            # All reasoning events should have a message_id
            message_ids = set()
            for event in reasoning_events:
                assert hasattr(event, 'message_id'), \
                    f"{event.type} should have a message_id attribute"
                assert event.message_id, \
                    f"{event.type} should have a non-empty message_id"
                message_ids.add(event.message_id)

            # All message_ids should be the same within a single reasoning block
            assert len(message_ids) == 1, \
                f"All reasoning events should share one message_id, got {message_ids}"

            print(f"✅ All reasoning events share message_id: {message_ids.pop()}")
        else:
            print("ℹ️ No REASONING events to validate message_id consistency")

    @pytest.mark.asyncio
    async def test_reasoning_message_start_has_role(self, thinking_agent):
        """Verify that REASONING_MESSAGE_START events include role='reasoning'."""
        input_data = self._create_input(
            "Is 97 a prime number? Think carefully."
        )

        events = []
        async for event in thinking_agent.run(input_data):
            events.append(event)

        msg_start_events = [
            e for e in events
            if e.type == EventType.REASONING_MESSAGE_START
        ]

        if msg_start_events:
            for event in msg_start_events:
                assert event.role == "reasoning", \
                    f"REASONING_MESSAGE_START should have role='reasoning', got '{event.role}'"
            print("✅ REASONING_MESSAGE_START events have role='reasoning'")
        else:
            print("ℹ️ No REASONING_MESSAGE_START events to validate role")

    @pytest.mark.asyncio
    async def test_reasoning_encrypted_value_emitted(self, thinking_agent):
        """Verify that REASONING_ENCRYPTED_VALUE events are emitted for thought signatures.

        When the Gemini model returns thought_signature bytes on thought parts,
        the middleware should emit REASONING_ENCRYPTED_VALUE events with:
        - subtype="message"
        - entity_id matching the reasoning message_id
        - encrypted_value containing the base64-encoded signature

        Note: Whether the model returns thought_signature depends on the API
        configuration. This test validates the flow when signatures are present.
        """
        import base64

        input_data = self._create_input(
            "Explain why the square root of 2 is irrational. "
            "Reason through the proof step by step."
        )

        events = []
        async for event in thinking_agent.run(input_data):
            events.append(event)

        encrypted_events = [
            e for e in events
            if e.type == EventType.REASONING_ENCRYPTED_VALUE
        ]

        if encrypted_events:
            print(f"✅ Found {len(encrypted_events)} REASONING_ENCRYPTED_VALUE event(s)")

            for event in encrypted_events:
                assert event.subtype == "message", \
                    f"Expected subtype='message', got '{event.subtype}'"
                assert event.entity_id, \
                    "entity_id should be non-empty"
                assert event.encrypted_value, \
                    "encrypted_value should be non-empty"

                # Verify it's valid base64
                try:
                    decoded = base64.b64decode(event.encrypted_value)
                    assert len(decoded) > 0, "Decoded signature should be non-empty"
                    print(f"  ✅ Valid base64 encrypted_value ({len(decoded)} bytes)")
                except Exception as e:
                    pytest.fail(f"encrypted_value is not valid base64: {e}")

                # entity_id should match one of our reasoning message_ids
                reasoning_msg_ids = {
                    e.message_id for e in events
                    if e.type == EventType.REASONING_MESSAGE_START
                }
                if reasoning_msg_ids:
                    assert event.entity_id in reasoning_msg_ids, \
                        f"entity_id '{event.entity_id}' should match a reasoning message_id"
        else:
            print("ℹ️ No REASONING_ENCRYPTED_VALUE events (model may not have returned thought_signature)")

    @pytest.mark.asyncio
    async def test_reasoning_stream_closed_before_text(self, thinking_agent):
        """Verify reasoning stream is fully closed before text message events begin.

        The event sequence should be:
        ... REASONING_MESSAGE_END, REASONING_END, ... TEXT_MESSAGE_START ...

        There should be no interleaving of reasoning and text events.
        """
        input_data = self._create_input(
            "What is 15 factorial? Show your calculation."
        )

        events = []
        async for event in thinking_agent.run(input_data):
            events.append(event)

        if not self._has_reasoning_events(events):
            print("ℹ️ No REASONING events to validate stream closure ordering")
            return

        # Find the last REASONING_END and first TEXT_MESSAGE_START
        last_reasoning_end_idx = None
        first_text_start_idx = None

        for i, event in enumerate(events):
            if event.type == EventType.REASONING_END:
                last_reasoning_end_idx = i
            if event.type == EventType.TEXT_MESSAGE_START and first_text_start_idx is None:
                first_text_start_idx = i

        if last_reasoning_end_idx is not None and first_text_start_idx is not None:
            assert last_reasoning_end_idx < first_text_start_idx, \
                "REASONING_END should come before TEXT_MESSAGE_START"
            print("✅ Reasoning stream fully closed before text message starts")
        else:
            print("ℹ️ Could not verify ordering (missing REASONING_END or TEXT_MESSAGE_START)")


if __name__ == "__main__":
    # Allow running directly for debugging
    import sys
    if os.environ.get("GOOGLE_API_KEY"):
        pytest.main([__file__, "-v", "-s"])
    else:
        print("GOOGLE_API_KEY not set, skipping integration tests")
        sys.exit(0)
