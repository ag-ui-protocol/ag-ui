"""Tool approvals as AG-UI interrupts, end to end through the real SDK run loop.

Every resume builds a fresh request from the previous run's
MESSAGES_SNAPSHOT, the way a client does, so these also show that nothing on
the server carries over from the paused run to the resumed one.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

import pytest
from agents import Agent, function_tool, handoff
from agents.models.interface import Model
from agents.tool_context import ToolContext
from openai.types.responses import (
    Response,
    ResponseCompletedEvent,
    ResponseFunctionToolCall,
    ResponseOutputItemAddedEvent,
    ResponseOutputItemDoneEvent,
    ResponseOutputMessage,
    ResponseOutputText,
    ResponseTextDeltaEvent,
)

from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    ResumeEntry,
    RunAgentInput,
    Tool,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from ag_ui_openai_agents import OpenAIAgentsAgent, resume_tool_calls
from ag_ui_openai_agents.interrupts import (
    ABANDONED,
    AMBIGUOUS,
    APPROVAL_SCHEMA,
    CANCELLED,
    REJECTED,
    UNAVAILABLE,
    UnresumableApprovalError,
    unresumable_approvals,
)


# ── a model that answers from a script ──────────────────────────────────


def call(name: str, arguments: dict[str, Any], call_id: str) -> ResponseFunctionToolCall:
    return ResponseFunctionToolCall(
        id=f"fc_{call_id}",
        call_id=call_id,
        name=name,
        arguments=json.dumps(arguments),
        type="function_call",
        status="completed",
    )


def text(content: str) -> ResponseOutputMessage:
    return ResponseOutputMessage(
        id="msg_1",
        role="assistant",
        status="completed",
        type="message",
        content=[ResponseOutputText(type="output_text", text=content, annotations=[])],
    )


class ScriptedModel(Model):
    """Answers each model call with the next scripted list of output items."""

    def __init__(self, *turns: list[Any]) -> None:
        self.turns = list(turns)
        self.inputs: list[Any] = []
        self.instructions: list[Any] = []

    async def get_response(self, *args: Any, **kwargs: Any) -> Any:
        # Non-streamed runs (an agent used as a tool runs its sub-agent this way).
        from agents.items import ModelResponse
        from agents.usage import Usage

        self.inputs.append(kwargs["input"] if "input" in kwargs else args[1])
        return ModelResponse(output=self.turns.pop(0), usage=Usage(), response_id=None)

    async def stream_response(self, *args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        self.inputs.append(kwargs["input"] if "input" in kwargs else args[1])
        self.instructions.append(
            kwargs["system_instructions"] if "system_instructions" in kwargs else args[0]
        )
        output = self.turns.pop(0)
        for index, item in enumerate(output):
            yield ResponseOutputItemAddedEvent(
                type="response.output_item.added", item=item, output_index=index, sequence_number=0
            )
            if isinstance(item, ResponseOutputMessage):
                yield ResponseTextDeltaEvent(
                    type="response.output_text.delta",
                    delta=item.content[0].text,
                    item_id=item.id,
                    output_index=index,
                    content_index=0,
                    logprobs=[],
                    sequence_number=0,
                )
            yield ResponseOutputItemDoneEvent(
                type="response.output_item.done", item=item, output_index=index, sequence_number=0
            )
        yield ResponseCompletedEvent(
            type="response.completed",
            sequence_number=0,
            response=Response(
                id=f"resp_{len(self.inputs)}",
                created_at=0,
                model="scripted",
                object="response",
                output=output,
                parallel_tool_calls=True,
                tool_choice="auto",
                tools=[],
            ),
        )


# ── an agent with an approval-gated tool ─────────────────────────────────

refunds: list[str] = []


@function_tool(needs_approval=True)
def issue_refund(order_id: str) -> str:
    """Issue a refund."""
    refunds.append(order_id)
    return f"Refunded {order_id}."


def refund_agent(*turns: list[Any]) -> tuple[OpenAIAgentsAgent, ScriptedModel]:
    model = ScriptedModel(*turns)
    agent = Agent(name="support", instructions="Help.", tools=[issue_refund], model=model)
    return OpenAIAgentsAgent(agent), model


def request(messages: list[Any], resume: list[ResumeEntry] | None = None, tools=()) -> RunAgentInput:
    return RunAgentInput(
        thread_id="t1",
        run_id="r1",
        messages=list(messages),
        tools=list(tools),
        state={},
        context=[],
        forwarded_props=None,
        resume=resume,
    )


def run(agent: OpenAIAgentsAgent, run_input: RunAgentInput) -> list[Any]:
    async def collect():
        return [event async for event in agent.run_streamed(run_input)]

    return asyncio.run(collect())


def finished(events: list[Any]) -> Any:
    [event] = [e for e in events if e.type == EventType.RUN_FINISHED]
    return event


def snapshot(events: list[Any]) -> list[Any]:
    return [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT][-1].messages


def paused_history() -> list[Any]:
    agent, _ = refund_agent([call("issue_refund", {"order_id": "ORD-1"}, "c1")])
    return snapshot(run(agent, request([UserMessage(id="u1", role="user", content="refund ORD-1")])))


@pytest.fixture(autouse=True)
def _clear_refunds():
    refunds.clear()


# ── pause ────────────────────────────────────────────────────────────────


def test_a_paused_tool_call_ends_the_run_with_an_interrupt():
    agent, model = refund_agent([call("issue_refund", {"order_id": "ORD-1"}, "c1")])
    events = run(agent, request([UserMessage(id="u1", role="user", content="refund ORD-1")]))

    outcome = finished(events).outcome
    assert outcome.type == "interrupt"
    [interrupt] = outcome.interrupts
    assert interrupt.id == interrupt.tool_call_id == "c1"
    # Not "tool_call": CopilotKit would answer that one itself (see below).
    assert interrupt.reason == "tool_approval"
    assert interrupt.message == "Approve call to issue_refund?"
    assert interrupt.response_schema == APPROVAL_SCHEMA
    assert interrupt.metadata == {"tool_name": "issue_refund", "tool_input": {"order_id": "ORD-1"}}

    assert EventType.TOOL_CALL_RESULT not in [e.type for e in events]
    assert refunds == [] and len(model.inputs) == 1  # nothing ran, the model waits
    # The paused call stays in the history the client keeps.
    assert any(
        isinstance(m, AssistantMessage) and m.tool_calls and m.tool_calls[0].id == "c1"
        for m in snapshot(events)
    )


# ── resume ───────────────────────────────────────────────────────────────


def test_an_approved_call_runs_once_and_the_run_continues():
    history = paused_history()
    agent, model = refund_agent([text("Done, ORD-1 is refunded.")])
    events = run(
        agent,
        request(history, resume=[ResumeEntry(interrupt_id="c1", status="resolved", payload={"approved": True})]),
    )
    kinds = [e.type for e in events]

    assert refunds == ["ORD-1"]
    result = next(e for e in events if e.type == EventType.TOOL_CALL_RESULT)
    assert (result.tool_call_id, result.content) == ("c1", "Refunded ORD-1.")
    assert kinds.index(EventType.RUN_STARTED) < kinds.index(EventType.TOOL_CALL_RESULT)
    assert kinds.index(EventType.TOOL_CALL_RESULT) < kinds.index(EventType.TEXT_MESSAGE_START)
    assert finished(events).outcome.type == "success"
    # The model saw the tool's output right after its call.
    sent = model.inputs[0]
    outputs = [item for item in sent if item.get("type") == "function_call_output"]
    assert [(o["call_id"], o["output"]) for o in outputs] == [("c1", "Refunded ORD-1.")]
    # The snapshot carries the answer, so the next request is complete.
    tool_messages = [m for m in snapshot(events) if isinstance(m, ToolMessage)]
    assert [(m.tool_call_id, m.id) for m in tool_messages] == [("c1", result.message_id)]


@pytest.mark.parametrize("payload", [{"approved": False}, {"approved": "true"}, "yes", None])
def test_anything_but_an_explicit_approval_rejects_the_call(payload):
    history = paused_history()
    agent, _ = refund_agent([text("Okay, no refund.")])
    events = run(
        agent,
        request(history, resume=[ResumeEntry(interrupt_id="c1", status="resolved", payload=payload)]),
    )
    assert next(e for e in events if e.type == EventType.TOOL_CALL_RESULT).content == REJECTED
    assert refunds == []


def test_a_cancelled_interrupt_does_not_run_the_tool():
    history = paused_history()
    agent, _ = refund_agent([text("Okay.")])
    events = run(agent, request(history, resume=[ResumeEntry(interrupt_id="c1", status="cancelled")]))
    assert next(e for e in events if e.type == EventType.TOOL_CALL_RESULT).content == CANCELLED
    assert refunds == []


def test_a_call_left_open_is_closed_when_the_user_moves_on():
    history = paused_history()
    history.append(UserMessage(id="u2", role="user", content="never mind"))
    agent, model = refund_agent([text("Sure.")])
    events = run(agent, request(history))

    assert next(e for e in events if e.type == EventType.TOOL_CALL_RESULT).content == ABANDONED
    assert refunds == []
    sent = model.inputs[0]
    kinds = [item.get("type") or item.get("role") for item in sent]
    # The output sits right after its call, before the new user message.
    assert kinds.index("function_call_output") == kinds.index("function_call") + 1
    assert sent[-1]["role"] == "user"


def test_client_tool_calls_are_left_for_the_client():
    history = [
        UserMessage(id="u1", role="user", content="confirm it"),
        AssistantMessage(
            id="a1",
            role="assistant",
            tool_calls=[ToolCall(id="c9", type="function", function=FunctionCall(name="confirm", arguments="{}"))],
        ),
    ]
    agent = Agent(name="support", instructions="Help.", tools=[issue_refund])
    resumed = asyncio.run(
        resume_tool_calls(
            agent,
            request(history, tools=[Tool(name="confirm", description="", parameters={"type": "object"})]),
        )
    )
    assert resumed.tool_results == []
    assert resumed.run_input.messages == history


def test_a_handoff_agents_tool_is_answered_too():
    specialist = Agent(name="refunds", instructions="Refund.", tools=[issue_refund])
    triage = Agent(name="triage", instructions="Route.", handoffs=[specialist])
    history = [
        UserMessage(id="u1", role="user", content="refund ORD-2"),
        AssistantMessage(
            id="a1",
            role="assistant",
            tool_calls=[
                ToolCall(
                    id="c2",
                    type="function",
                    function=FunctionCall(name="issue_refund", arguments='{"order_id": "ORD-2"}'),
                )
            ],
        ),
    ]
    resumed = asyncio.run(
        resume_tool_calls(
            triage,
            request(history, resume=[ResumeEntry(interrupt_id="c2", status="resolved", payload={"approved": True})]),
        )
    )
    assert [e.content for e in resumed.tool_results] == ["Refunded ORD-2."]
    assert refunds == ["ORD-2"]


def test_a_decision_the_client_also_wrote_as_the_tool_result_still_runs_the_tool():
    # CopilotKit answers a "tool_call" interrupt by adding a tool message whose
    # content is the response, next to the resume entry. For the agent's own
    # tool the entry decides: the tool runs and its output replaces that message.
    history = paused_history()
    history.append(
        ToolMessage(id="client-1", role="tool", tool_call_id="c1", content='{"approved":true}')
    )
    agent, model = refund_agent([text("Done.")])
    events = run(
        agent,
        request(history, resume=[ResumeEntry(interrupt_id="c1", status="resolved", payload={"approved": True})]),
    )
    assert refunds == ["ORD-1"]
    outputs = [item for item in model.inputs[0] if item.get("type") == "function_call_output"]
    assert [o["output"] for o in outputs] == ["Refunded ORD-1."]
    tool_messages = [m for m in snapshot(events) if isinstance(m, ToolMessage)]
    assert [(m.tool_call_id, m.content) for m in tool_messages] == [("c1", "Refunded ORD-1.")]


def _paused_call(name: str, arguments: str, call_id: str = "c3") -> list[Any]:
    return [
        UserMessage(id="u1", role="user", content="do it"),
        AssistantMessage(
            id="a1",
            role="assistant",
            tool_calls=[ToolCall(id=call_id, type="function", function=FunctionCall(name=name, arguments=arguments))],
        ),
    ]


def test_a_tool_behind_an_sdk_handoff_object_is_answered():
    specialist = Agent(name="refunds", instructions="Refund.", tools=[issue_refund])
    triage = Agent(name="triage", instructions="Route.", handoffs=[handoff(specialist)])
    resumed = asyncio.run(
        resume_tool_calls(
            triage,
            request(
                _paused_call("issue_refund", '{"order_id": "ORD-3"}'),
                resume=[ResumeEntry(interrupt_id="c3", status="resolved", payload={"approved": True})],
            ),
        )
    )
    assert [e.content for e in resumed.tool_results] == ["Refunded ORD-3."]
    assert refunds == ["ORD-3"]


def test_an_approved_call_does_not_run_when_two_agents_share_the_tool_name():
    # The history does not say which agent made the call, so running either
    # tool could run the wrong backend operation.
    ran: list[str] = []

    @function_tool(name_override="update_account", needs_approval=True)
    def root_update(change: str) -> str:
        """Root agent's update."""
        ran.append("root")
        return "root"

    @function_tool(name_override="update_account", needs_approval=True)
    def specialist_update(change: str) -> str:
        """Specialist's update."""
        ran.append("specialist")
        return "specialist"

    specialist = Agent(name="accounts", instructions="Accounts.", tools=[specialist_update])
    root = Agent(name="root", instructions="Route.", tools=[root_update], handoffs=[handoff(specialist)])
    resumed = asyncio.run(
        resume_tool_calls(
            root,
            request(
                _paused_call("update_account", '{"change": "x"}'),
                resume=[ResumeEntry(interrupt_id="c3", status="resolved", payload={"approved": True})],
            ),
        )
    )
    assert [e.content for e in resumed.tool_results] == [AMBIGUOUS]
    assert ran == []


def test_an_approval_inside_an_agent_tool_fails_instead_of_waiting_forever():
    # The inner call runs in the sub-agent's own run, so the conversation holds
    # only the outer agent-tool call: an interrupt for the inner call could
    # never be answered.
    inner = Agent(
        name="refunds",
        instructions="Refund.",
        tools=[issue_refund],
        model=ScriptedModel([call("issue_refund", {"order_id": "ORD-4"}, "inner_1")]),
    )
    model = ScriptedModel([call("refunds", {"input": "refund ORD-4"}, "outer_1")])
    outer = Agent(
        name="support",
        instructions="Help.",
        tools=[inner.as_tool(tool_name="refunds", tool_description="Refunds.")],
        model=model,
    )
    agent = OpenAIAgentsAgent(outer)

    async def collect():
        events = []
        with pytest.raises(UnresumableApprovalError):
            async for event in agent.run_streamed(
                request([UserMessage(id="u1", role="user", content="refund ORD-4")])
            ):
                events.append(event)
        return events

    events = asyncio.run(collect())
    assert events[-1].type == EventType.RUN_ERROR
    assert "issue_refund" in events[-1].message
    assert refunds == []


def test_a_resumed_tool_gets_the_run_config_and_its_agent():
    # An agent used as a tool takes its model provider from the run config,
    # so a resumed call needs the same configuration as a live one.
    from agents import RunConfig

    @function_tool(needs_approval=True)
    def report(ctx: ToolContext[Any]) -> str:
        """Report the run's workflow and the tool's agent."""
        return f"{ctx.run_config.workflow_name} / {ctx.agent.name}"

    owner = Agent(name="ops", instructions="Ops.", tools=[report])
    resumed = asyncio.run(
        resume_tool_calls(
            owner,
            request(
                _paused_call("report", "{}"),
                resume=[ResumeEntry(interrupt_id="c3", status="resolved", payload={"approved": True})],
            ),
            run_config=RunConfig(workflow_name="wf-1"),
        )
    )
    assert [e.content for e in resumed.tool_results] == ["wf-1 / ops"]


def test_approvals_that_cannot_be_resumed_are_named():
    from types import SimpleNamespace

    from agents.items import ToolApprovalItem

    owner = Agent(name="ops", instructions="Ops.")
    function_call = SimpleNamespace(type="function_call", call_id="c1", name="issue_refund")
    nested_call = SimpleNamespace(type="function_call", call_id="c2", name="inner_tool")
    shell_call = SimpleNamespace(type="shell_call", call_id="c3", name=None)
    items = [
        ToolApprovalItem(agent=owner, raw_item=function_call, tool_name="issue_refund"),
        ToolApprovalItem(agent=owner, raw_item=nested_call, tool_name="inner_tool"),
        ToolApprovalItem(agent=owner, raw_item=shell_call, tool_name="shell"),
    ]
    # c2 was never streamed (it ran inside an agent tool); c3 is a built-in tool.
    assert unresumable_approvals(items, ["c1", "c3"]) == ["inner_tool", "shell"]


@pytest.mark.parametrize("is_enabled", [False, lambda ctx, agent: False])
def test_an_approved_call_does_not_run_a_tool_that_is_now_disabled(is_enabled):
    # The SDK only offers enabled tools; resuming must not bypass that.
    ran: list[str] = []

    @function_tool(needs_approval=True, is_enabled=is_enabled)
    def wipe() -> str:
        """Wipe it."""
        ran.append("wipe")
        return "wiped"

    resumed = asyncio.run(
        resume_tool_calls(
            Agent(name="ops", instructions="Ops.", tools=[wipe]),
            request(
                _paused_call("wipe", "{}"),
                resume=[ResumeEntry(interrupt_id="c3", status="resolved", payload={"approved": True})],
            ),
        )
    )
    assert [e.content for e in resumed.tool_results] == [UNAVAILABLE]
    assert ran == []


def test_an_approved_call_of_an_mcp_server_tool_runs_on_that_server():
    # MCP server tools are listed at run time, not kept in agent.tools.
    from agents.mcp import MCPServer
    from mcp.types import CallToolResult, TextContent
    from mcp.types import Tool as MCPTool

    calls: list[tuple[str, Any]] = []

    class FakeServer(MCPServer):
        def __init__(self) -> None:
            super().__init__(require_approval="always")

        @property
        def name(self) -> str:
            return "docs"

        async def connect(self) -> None:
            pass

        async def cleanup(self) -> None:
            pass

        async def list_tools(self, run_context=None, agent=None):
            return [MCPTool(name="lookup", inputSchema={"type": "object", "properties": {}})]

        async def call_tool(self, tool_name, arguments, meta=None):
            calls.append((tool_name, arguments))
            return CallToolResult(content=[TextContent(type="text", text="found it")])

        async def list_prompts(self):
            raise NotImplementedError

        async def get_prompt(self, name, arguments=None):
            raise NotImplementedError

    agent = Agent(name="docs", instructions="Look things up.", mcp_servers=[FakeServer()])
    resumed = asyncio.run(
        resume_tool_calls(
            agent,
            request(
                _paused_call("lookup", '{"q": "x"}'),
                resume=[ResumeEntry(interrupt_id="c3", status="resolved", payload={"approved": True})],
            ),
        )
    )
    assert calls == [("lookup", {"q": "x"})]
    assert ["found it" in e.content for e in resumed.tool_results] == [True]


def test_a_resumed_tool_keeps_its_timeout():
    @function_tool(needs_approval=True, timeout=0.01)
    async def slow() -> str:
        """Takes too long."""
        await asyncio.sleep(0.2)
        return "finished"

    resumed = asyncio.run(
        resume_tool_calls(
            Agent(name="ops", instructions="Ops.", tools=[slow]),
            request(
                _paused_call("slow", "{}"),
                resume=[ResumeEntry(interrupt_id="c3", status="resolved", payload={"approved": True})],
            ),
        )
    )
    [result] = resumed.tool_results
    assert result.content != "finished" and "timed out" in result.content.lower()


@pytest.mark.parametrize("answered", [True, False])
def test_an_approval_whose_tool_is_gone_is_closed_not_left_open(answered):
    # The tool was removed (or its MCP server no longer lists it) between the
    # pause and the resume; an open call would go back without an output.
    resumed = asyncio.run(
        resume_tool_calls(
            Agent(name="ops", instructions="Ops."),
            request(
                _paused_call("retired_tool", "{}"),
                # Answered, or the user moved on without answering.
                resume=[ResumeEntry(interrupt_id="c3", status="resolved", payload={"approved": True})]
                if answered
                else None,
            ),
        )
    )
    assert [e.content for e in resumed.tool_results] == [UNAVAILABLE]


def test_hosted_and_client_calls_are_not_closed_by_the_backend():
    history = _paused_call("web_search_call", "") + _paused_call("confirm", "{}", call_id="c4")
    resumed = asyncio.run(
        resume_tool_calls(
            Agent(name="ops", instructions="Ops."),
            request(history, tools=[Tool(name="confirm", description="", parameters={"type": "object"})]),
        )
    )
    assert resumed.tool_results == []


def test_an_approved_agent_tool_whose_sub_agent_pauses_fails_clearly():
    # The inner pause has no call in the conversation; reporting the agent
    # tool's empty output as its result would hide that nothing ran.
    inner = Agent(
        name="refunds",
        instructions="Refund.",
        tools=[issue_refund],
        model=ScriptedModel([call("issue_refund", {"order_id": "ORD-5"}, "inner_1")]),
    )
    outer = Agent(
        name="support",
        instructions="Help.",
        tools=[inner.as_tool(tool_name="refunds", tool_description="Refunds.", needs_approval=True)],
    )
    with pytest.raises(UnresumableApprovalError):
        asyncio.run(
            resume_tool_calls(
                outer,
                request(
                    _paused_call("refunds", '{"input": "refund ORD-5"}'),
                    resume=[ResumeEntry(interrupt_id="c3", status="resolved", payload={"approved": True})],
                ),
            )
        )
    assert refunds == []


def test_a_resumed_tool_sees_its_call_and_the_conversation():
    @function_tool(needs_approval=True)
    def inspect_call(ctx: ToolContext[Any]) -> str:
        """Report what the tool context holds."""
        kinds = [item.get("type") or item.get("role") for item in ctx.turn_input]
        return f"{ctx.tool_call.call_id} {ctx.tool_call.name} {kinds}"

    resumed = asyncio.run(
        resume_tool_calls(
            Agent(name="ops", instructions="Ops.", tools=[inspect_call]),
            request(
                _paused_call("inspect_call", "{}"),
                resume=[ResumeEntry(interrupt_id="c3", status="resolved", payload={"approved": True})],
            ),
        )
    )
    assert [e.content for e in resumed.tool_results] == ["c3 inspect_call ['message', 'function_call']"]


def test_an_mcp_tool_shared_by_an_agent_and_its_handoff_target_is_not_ambiguous():
    # Each agent lists the shared server itself and gets its own wrapper for
    # the same operation.
    from agents.mcp import MCPServer
    from mcp.types import CallToolResult, TextContent
    from mcp.types import Tool as MCPTool

    calls: list[str] = []

    class Shared(MCPServer):
        def __init__(self) -> None:
            super().__init__(require_approval="always")

        @property
        def name(self) -> str:
            return "docs"

        async def connect(self) -> None:
            pass

        async def cleanup(self) -> None:
            pass

        async def list_tools(self, run_context=None, agent=None):
            return [MCPTool(name="lookup", inputSchema={"type": "object", "properties": {}})]

        async def call_tool(self, tool_name, arguments, meta=None):
            calls.append(tool_name)
            return CallToolResult(content=[TextContent(type="text", text="found")])

        async def list_prompts(self):
            raise NotImplementedError

        async def get_prompt(self, name, arguments=None):
            raise NotImplementedError

    server = Shared()
    specialist = Agent(name="docs", instructions="Docs.", mcp_servers=[server])
    triage = Agent(name="triage", instructions="Route.", mcp_servers=[server], handoffs=[specialist])
    resumed = asyncio.run(
        resume_tool_calls(
            triage,
            request(
                _paused_call("lookup", "{}"),
                resume=[ResumeEntry(interrupt_id="c3", status="resolved", payload={"approved": True})],
            ),
        )
    )
    assert calls == ["lookup"]
    assert ["found" in e.content for e in resumed.tool_results] == [True]


def test_a_reused_call_id_only_resumes_the_paused_call():
    # Some providers reuse call ids across turns. Approving the second refund
    # must not drop the first one's result or refund that order again.
    def refund_call(message_id: str, order: str) -> AssistantMessage:
        return AssistantMessage(
            id=message_id,
            role="assistant",
            tool_calls=[
                ToolCall(
                    id="call_0",
                    type="function",
                    function=FunctionCall(name="issue_refund", arguments=json.dumps({"order_id": order})),
                )
            ],
        )

    history = [
        UserMessage(id="u1", role="user", content="refund ORD-1"),
        refund_call("a1", "ORD-1"),
        ToolMessage(id="call_0-result", role="tool", tool_call_id="call_0", content="Refunded ORD-1."),
        UserMessage(id="u2", role="user", content="and ORD-2"),
        refund_call("a2", "ORD-2"),
    ]
    resumed = asyncio.run(
        resume_tool_calls(
            Agent(name="support", instructions="Help.", tools=[issue_refund]),
            request(history, resume=[ResumeEntry(interrupt_id="call_0", status="resolved", payload={"approved": True})]),
        )
    )
    assert refunds == ["ORD-2"]
    tool_messages = [m for m in resumed.run_input.messages if isinstance(m, ToolMessage)]
    assert [m.content for m in tool_messages] == ["Refunded ORD-1.", "Refunded ORD-2."]
    assert len({m.id for m in tool_messages}) == 2
