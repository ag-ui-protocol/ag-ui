"""Integration tests for reasoning (thinking) events with OpenAI o3-mini.

These tests hit the live OpenAI API with a reasoning model. Reasoning
events (response.reasoning_text.*) are only emitted when the provider
streams reasoning tokens. Without org verification or explicit config,
o3-mini reasons internally without streaming those tokens.

The tests verify that:
  - o3-mini produces correct text output through the agent
  - Thinking events are handled correctly if/when they appear

    pytest -m reasoning python/tests/integration/test_reasoning.py
"""

import os

import pytest

from ag_ui.core import EventType, RunAgentInput, UserMessage

from ag_ui_openresponses import (
    OpenResponsesAgent,
    OpenResponsesAgentConfig,
)

pytestmark = [
    pytest.mark.skipif(
        not os.environ.get("OPENAI_API_KEY"),
        reason="OPENAI_API_KEY environment variable not set",
    ),
    pytest.mark.reasoning,
]


@pytest.fixture
def reasoning_agent() -> OpenResponsesAgent:
    """Create an agent configured for o3-mini (reasoning model)."""
    return OpenResponsesAgent(
        OpenResponsesAgentConfig(
            base_url="https://api.openai.com/v1",
            api_key=os.environ.get("OPENAI_API_KEY", ""),
            default_model="o3-mini",
        )
    )


@pytest.fixture
def reasoning_input() -> RunAgentInput:
    """A prompt that exercises reasoning."""
    return RunAgentInput(
        thread_id="reasoning-thread",
        run_id="reasoning-run",
        messages=[
            UserMessage(
                id="msg-1",
                role="user",
                content="What is 7 * 13 + 29? Think step by step.",
            )
        ],
        tools=[],
        context=[],
        state={},
        forwarded_props={},
    )


class TestReasoningModelIntegration:
    """Live tests with a reasoning model (o3-mini)."""

    @pytest.mark.asyncio
    async def test_reasoning_model_produces_correct_output(
        self, reasoning_agent: OpenResponsesAgent, reasoning_input: RunAgentInput
    ):
        """o3-mini should produce a correct text response."""
        events = []
        async for event in reasoning_agent.run(reasoning_input):
            events.append(event)

        event_types = [e.type for e in events]

        assert event_types[0] == EventType.RUN_STARTED
        assert event_types[-1] == EventType.RUN_FINISHED
        assert EventType.TEXT_MESSAGE_START in event_types
        assert EventType.TEXT_MESSAGE_CONTENT in event_types
        assert EventType.TEXT_MESSAGE_END in event_types

        text_content = [e for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT]
        full_text = "".join(e.delta for e in text_content)
        assert "120" in full_text

    @pytest.mark.asyncio
    async def test_thinking_events_well_formed_if_present(
        self, reasoning_agent: OpenResponsesAgent, reasoning_input: RunAgentInput
    ):
        """If thinking events appear, they should follow START -> CONTENT+ -> END."""
        events = []
        async for event in reasoning_agent.run(reasoning_input):
            events.append(event)

        thinking_events = [
            e for e in events
            if e.type in (
                EventType.THINKING_TEXT_MESSAGE_START,
                EventType.THINKING_TEXT_MESSAGE_CONTENT,
                EventType.THINKING_TEXT_MESSAGE_END,
            )
        ]

        if not thinking_events:
            pytest.skip(
                "No thinking events emitted (reasoning tokens not streamed "
                "by this provider/org configuration)"
            )

        assert thinking_events[0].type == EventType.THINKING_TEXT_MESSAGE_START
        assert thinking_events[-1].type == EventType.THINKING_TEXT_MESSAGE_END

        msg_id = thinking_events[0].message_id
        for e in thinking_events:
            if e.type == EventType.THINKING_TEXT_MESSAGE_CONTENT:
                assert e.message_id == msg_id
