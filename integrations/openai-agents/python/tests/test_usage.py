"""Token usage on RUN_FINISHED covers the run's sub-agents too."""

from __future__ import annotations

import asyncio
from typing import Any

from agents import Agent
from agents.items import ModelResponse
from agents.usage import Usage
from openai.types.responses import ResponseCompletedEvent, ResponseUsage
from openai.types.responses.response_usage import InputTokensDetails, OutputTokensDetails
from test_interrupts import ScriptedModel, call, finished, request, text

from ag_ui.core import UserMessage
from ag_ui_openai_agents import OpenAIAgentsAgent


def _usage(input_tokens: int, output_tokens: int) -> ResponseUsage:
    return ResponseUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
        input_tokens_details=InputTokensDetails(cached_tokens=0, cache_write_tokens=0),
        output_tokens_details=OutputTokensDetails(reasoning_tokens=0),
    )


class StreamedWithUsage(ScriptedModel):
    """Streams like ScriptedModel, reporting 10 in / 2 out per call."""

    async def stream_response(self, *args: Any, **kwargs: Any):
        async for event in super().stream_response(*args, **kwargs):
            if isinstance(event, ResponseCompletedEvent):
                event = event.model_copy(
                    update={"response": event.response.model_copy(update={"usage": _usage(10, 2)})}
                )
            yield event


class SubAgentWithUsage(ScriptedModel):
    """Answers non-streamed calls (an agent used as a tool), 100 in / 20 out."""

    async def get_response(self, *args: Any, **kwargs: Any) -> Any:
        return ModelResponse(
            output=self.turns.pop(0),
            usage=Usage(requests=1, input_tokens=100, output_tokens=20, total_tokens=120),
            response_id=None,
        )


def test_usage_includes_calls_made_by_an_agent_used_as_a_tool():
    inner = Agent(name="researcher", instructions="Research.", model=SubAgentWithUsage([text("Facts.")]))
    outer = Agent(
        name="supervisor",
        instructions="Delegate.",
        tools=[inner.as_tool(tool_name="research", tool_description="Research.")],
        model=StreamedWithUsage([call("research", {"input": "AI"}, "c1")], [text("Done.")]),
    )

    async def collect():
        return [e async for e in OpenAIAgentsAgent(outer).run_streamed(
            request([UserMessage(id="u1", role="user", content="go")])
        )]

    usage = finished(asyncio.run(collect())).usage
    by_model = {entry.model: (entry.input_tokens, entry.output_tokens, entry.total_tokens) for entry in usage}
    # Two streamed calls of the supervisor, and the sub-agent's call, which the
    # stream never showed.
    assert by_model == {"scripted": (20, 4, 24), None: (100, 20, 120)}


def test_usage_includes_an_approved_agent_tool_run_while_resuming():
    # The approved sub-agent runs before the SDK run starts, outside both the
    # stream and the SDK's run total.
    from ag_ui.core import AssistantMessage, FunctionCall, ResumeEntry, ToolCall

    inner = Agent(name="researcher", instructions="Research.", model=SubAgentWithUsage([text("Facts.")]))
    outer = Agent(
        name="supervisor",
        instructions="Delegate.",
        tools=[inner.as_tool(tool_name="research", tool_description="Research.", needs_approval=True)],
        model=StreamedWithUsage([text("Done.")]),
    )
    history = [
        UserMessage(id="u1", role="user", content="go"),
        AssistantMessage(
            id="a1",
            role="assistant",
            tool_calls=[ToolCall(id="c1", type="function", function=FunctionCall(name="research", arguments='{"input": "AI"}'))],
        ),
    ]
    run_input = request(
        history, resume=[ResumeEntry(interrupt_id="c1", status="resolved", payload={"approved": True})]
    )

    async def collect():
        return [e async for e in OpenAIAgentsAgent(outer).run_streamed(run_input)]

    usage = finished(asyncio.run(collect())).usage
    by_model = {entry.model: (entry.input_tokens, entry.output_tokens) for entry in usage}
    assert by_model == {"scripted": (10, 2), None: (100, 20)}
