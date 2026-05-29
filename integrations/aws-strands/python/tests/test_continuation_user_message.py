"""Tests for continuation-run user_message extraction in StrandsAgent.

When a frontend tool result arrives on a continuation run, the actual tool 
result content is forwarded to the Strands agent (via stream_async) rather 
than being replaced by a hardcoded fallback.

Scenario A – Tool result has content → agent receives that content verbatim.
Scenario B – Tool result has no content → agent receives the fallback string.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from ag_ui.core import (
    AssistantMessage,
    FunctionCall,
    RunAgentInput,
    Tool,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _template_agent() -> MagicMock:
    """Minimal mock satisfying StrandsAgent.__init__ attribute access."""
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    return mock


def _build_agent(
    thread_id: str,
    stream_events: list,
    config: StrandsAgentConfig | None = None,
) -> tuple[StrandsAgent, list]:
    """Create a StrandsAgent pre-wired with a mock inner agent for *thread_id*.

    Returns a tuple of (agent, captured_calls) where captured_calls collects
    each argument passed to stream_async so tests can assert on user_message.
    """
    agent = StrandsAgent(
        _template_agent(), name="test-agent", config=config or StrandsAgentConfig()
    )

    mock_inner = MagicMock()
    mock_inner.tool_registry = ToolRegistry()

    captured_calls: list = []

    async def _stream(msg):
        captured_calls.append(msg)
        for event in stream_events:
            yield event

    mock_inner.stream_async = _stream
    agent._agents_by_thread[thread_id] = mock_inner
    return agent, captured_calls


def _run_input(
    thread_id: str = "t1",
    messages: list | None = None,
    tools: list | None = None,
) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id="r1",
        state={},
        messages=messages or [UserMessage(id="u1", content="hello")],
        tools=tools or [],
        context=[],
        forwarded_props={},
    )


async def _collect(agent: StrandsAgent, inp: RunAgentInput) -> list:
    return [e async for e in agent.run(inp)]


# ---------------------------------------------------------------------------
# Scenario A – Tool result content is forwarded to the agent
# ---------------------------------------------------------------------------

class TestContinuationForwardsToolContent:
    """
    When a frontend tool returns content (success or error), the continuation
    run must forward that content as the user_message to stream_async so the
    Strands agent can see and respond to it.

    Before the fix (issue #1617): content was always discarded and replaced
    with a hardcoded "{tool_name} executed successfully with no return value."

    After the fix: msg.content is used when present.
    """

    THREAD = "content-forward-thread"
    TOOLS = [Tool(name="frontend_tool", description="a tool", parameters={})]

    def _messages(self, content: str) -> list:
        """Simulate a continuation: trailing tool message with given content."""
        tc = ToolCall(
            id="tc-1",
            function=FunctionCall(name="frontend_tool", arguments="{}"),
        )
        return [
            UserMessage(id="u1", content="do something"),
            AssistantMessage(id="a1", tool_calls=[tc]),
            ToolMessage(id="t1", content=content, tool_call_id="tc-1"),
        ]

    @pytest.mark.asyncio
    async def test_tool_result_content_forwarded_to_agent(self):
        """Agent receives actual tool result content, not the fallback."""
        stream_events: list = []  # No further LLM output needed for this test
        agent, captured = _build_agent(self.THREAD, stream_events)
        inp = _run_input(
            self.THREAD,
            messages=self._messages("Error: foo bar baz."),
            tools=self.TOOLS,
        )
        await _collect(agent, inp)

        assert len(captured) == 1, f"Expected 1 stream_async call, got {len(captured)}"
        assert captured[0] == "Error: foo bar baz.", (
            f"Expected tool content to be forwarded; got: {captured[0]!r}"
        )

    @pytest.mark.asyncio
    async def test_successful_result_content_forwarded(self):
        """A successful tool result string is also forwarded verbatim."""
        stream_events: list = []
        agent, captured = _build_agent(self.THREAD + "-success", stream_events)
        inp = _run_input(
            self.THREAD + "-success",
            messages=self._messages("Result: 42"),
            tools=self.TOOLS,
        )
        await _collect(agent, inp)

        assert len(captured) == 1
        assert captured[0] == "Result: 42", (
            f"Expected 'Result: 42'; got: {captured[0]!r}"
        )


# ---------------------------------------------------------------------------
# Scenario B – Empty tool result uses fallback message
# ---------------------------------------------------------------------------

class TestContinuationFallbackWhenNoContent:
    """
    When a frontend tool returns empty/no content, the continuation run should
    use the fallback string so the agent still gets a meaningful message.
    """

    THREAD = "fallback-thread"
    TOOLS = [Tool(name="frontend_tool", description="a tool", parameters={})]

    def _messages(self, content: str | None) -> list:
        """Simulate a continuation: trailing tool message with empty content."""
        tc = ToolCall(
            id="tc-1",
            function=FunctionCall(name="frontend_tool", arguments="{}"),
        )
        return [
            UserMessage(id="u1", content="do something"),
            AssistantMessage(id="a1", tool_calls=[tc]),
            ToolMessage(id="t1", content=content or "", tool_call_id="tc-1"),
        ]

    @pytest.mark.asyncio
    async def test_empty_content_uses_fallback(self):
        """When tool content is empty string, the fallback message is used."""
        stream_events: list = []
        agent, captured = _build_agent(self.THREAD, stream_events)
        inp = _run_input(
            self.THREAD,
            messages=self._messages(""),
            tools=self.TOOLS,
        )
        await _collect(agent, inp)

        assert len(captured) == 1
        assert captured[0] == "frontend_tool executed successfully with no return value.", (
            f"Expected fallback message; got: {captured[0]!r}"
        )
