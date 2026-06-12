"""Tests for the AG-UI interrupt-and-resume protocol in StrandsAgent.

The interrupt protocol is built on top of the Strands native interrupt system:

- StrandsInterruptHook fires on BeforeToolCallEvent for interrupt_on_call tools
  and calls event.interrupt(), which suspends the Strands agent loop natively.
- agent.py detects result.stop_reason == "interrupt" in the AgentResult event
  and emits RunFinishedInterruptOutcome using the Strands interrupt IDs directly.
- On resume, input_data.resume entries are converted to interruptResponse dicts
  and passed to stream_async() — Strands resumes from its checkpoint.

Covers:
- interrupt_on_call=True emits RunFinishedInterruptOutcome with correct fields
- interrupt_on_call=False (default) keeps legacy pending_halt behaviour (no interrupt outcome)
- Normal runs (no frontend tool) emit RunFinishedSuccessOutcome
- Resume: resolved+approved passes "y" to Strands and run continues
- Resume: resolved+denied passes "n" to Strands and run continues
- Resume: cancelled deactivates Strands interrupt state and ends cleanly
- Resume: unknown interrupt_id yields RunErrorEvent
- Resume: no pending interrupt on thread yields RunErrorEvent
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence
from unittest.mock import MagicMock

import pytest
from ag_ui.core import (
    EventType,
    RunAgentInput,
    Tool,
    UserMessage,
)
from strands.interrupt import Interrupt as StrandsInterrupt
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig, ToolBehavior
from ag_ui_strands import (
    Interrupt,
    ResumeEntry,
    RunFinishedInterruptOutcome,
    RunFinishedSuccessOutcome,
)


# ---------------------------------------------------------------------------
# Minimal AgentResult stub
# ---------------------------------------------------------------------------

@dataclass
class _FakeMetrics:
    pass


@dataclass
class _FakeAgentResult:
    """Minimal stand-in for strands.agent.agent_result.AgentResult."""
    stop_reason: str
    message: dict = field(default_factory=lambda: {"role": "assistant", "content": []})
    metrics: Any = field(default_factory=_FakeMetrics)
    state: Any = field(default_factory=dict)
    interrupts: Sequence[StrandsInterrupt] | None = None
    structured_output: Any = None


def _make_strands_interrupt(
    tool_name: str = "my_tool",
    tool_input: dict | None = None,
    tool_use_id: str = "st-1",
) -> StrandsInterrupt:
    """Build a Strands Interrupt as the hook would produce it."""
    import uuid
    interrupt_id = f"v1:before_tool_call:{tool_use_id}:{uuid.uuid5(uuid.NAMESPACE_OID, f'ag_ui:tool_call:{tool_name}')}"
    return StrandsInterrupt(
        id=interrupt_id,
        name=f"ag_ui:tool_call:{tool_name}",
        reason={"tool_name": tool_name, "tool_input": tool_input or {}},
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _template_agent() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    return mock


def _make_interrupt_state(activated: bool = False, interrupts: dict | None = None) -> MagicMock:
    """Build a mock _interrupt_state matching Strands' interface."""
    state = MagicMock()
    state.activated = activated
    state.interrupts = interrupts or {}
    state.deactivate = MagicMock(side_effect=lambda: setattr(state, "activated", False))
    return state


def _build_agent(
    thread_id: str,
    stream_events: list,
    config: StrandsAgentConfig | None = None,
    interrupt_state: MagicMock | None = None,
) -> StrandsAgent:
    agent = StrandsAgent(
        _template_agent(), name="test-agent", config=config or StrandsAgentConfig()
    )
    mock_inner = MagicMock()
    mock_inner.tool_registry = ToolRegistry()

    # Wire interrupt state
    mock_inner._interrupt_state = interrupt_state or _make_interrupt_state()

    async def _stream(_msg: Any):
        for event in stream_events:
            yield event

    mock_inner.stream_async = _stream
    agent._agents_by_thread[thread_id] = mock_inner
    return agent


def _run_input(
    thread_id: str = "t1",
    messages: list | None = None,
    tools: list | None = None,
    resume: list | None = None,
) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id="r1",
        state={},
        messages=messages or [UserMessage(id="u1", content="hello")],
        tools=tools or [],
        context=[],
        forwarded_props={},
        resume=resume,
    )


async def _collect(agent: StrandsAgent, inp: RunAgentInput) -> list:
    return [e async for e in agent.run(inp)]


def _frontend_tool_stream_with_interrupt(
    tool_name: str = "my_tool",
    tool_use_id: str = "st-1",
) -> list:
    """Stream that ends with an AgentResult carrying stop_reason='interrupt'."""
    strands_interrupt = _make_strands_interrupt(tool_name, {}, tool_use_id)
    return [
        {"current_tool_use": {"name": tool_name, "toolUseId": tool_use_id, "input": {}}},
        {"event": {"contentBlockStop": {}}},
        {"result": _FakeAgentResult(
            stop_reason="interrupt",
            interrupts=[strands_interrupt],
        )},
    ]


def _empty_stream() -> list:
    return [
        {"result": _FakeAgentResult(stop_reason="end_turn")},
    ]


# ---------------------------------------------------------------------------
# interrupt_on_call=True — interrupt outcome emitted
# ---------------------------------------------------------------------------

class TestInterruptOutcomeEmitted:
    THREAD = "interrupt-thread"
    TOOL = Tool(name="my_tool", description="d", parameters={})

    def _config(self) -> StrandsAgentConfig:
        return StrandsAgentConfig(
            tool_behaviors={"my_tool": ToolBehavior(interrupt_on_call=True)}
        )

    async def test_run_finished_has_interrupt_outcome(self):
        agent = _build_agent(self.THREAD, _frontend_tool_stream_with_interrupt(), self._config())
        events = await _collect(agent, _run_input(self.THREAD, tools=[self.TOOL]))

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        assert len(finished) == 1
        outcome = finished[0].outcome
        assert isinstance(outcome, RunFinishedInterruptOutcome)
        assert outcome.type == "interrupt"

    async def test_interrupt_has_correct_reason(self):
        agent = _build_agent(self.THREAD + "-reason", _frontend_tool_stream_with_interrupt(), self._config())
        events = await _collect(agent, _run_input(self.THREAD + "-reason", tools=[self.TOOL]))

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        interrupt = finished[0].outcome.interrupts[0]
        assert interrupt.reason == "tool_call"

    async def test_interrupt_id_matches_strands_id(self):
        """The AG-UI interrupt.id must be the Strands deterministic interrupt ID."""
        strands_interrupt = _make_strands_interrupt("my_tool", {}, "st-1")
        stream = [
            {"current_tool_use": {"name": "my_tool", "toolUseId": "st-1", "input": {}}},
            {"event": {"contentBlockStop": {}}},
            {"result": _FakeAgentResult(stop_reason="interrupt", interrupts=[strands_interrupt])},
        ]
        agent = _build_agent(self.THREAD + "-id", stream, self._config())
        events = await _collect(agent, _run_input(self.THREAD + "-id", tools=[self.TOOL]))

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        ag_ui_interrupt = finished[0].outcome.interrupts[0]
        assert ag_ui_interrupt.id == strands_interrupt.id

    async def test_interrupt_has_response_schema(self):
        agent = _build_agent(self.THREAD + "-schema", _frontend_tool_stream_with_interrupt(), self._config())
        events = await _collect(agent, _run_input(self.THREAD + "-schema", tools=[self.TOOL]))

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        interrupt = finished[0].outcome.interrupts[0]
        assert interrupt.response_schema is not None
        assert "approved" in interrupt.response_schema.get("properties", {})

    async def test_interrupt_id_is_deterministic(self):
        """Same tool call + same name always produces the same interrupt ID."""
        si1 = _make_strands_interrupt("my_tool", {}, "st-1")
        si2 = _make_strands_interrupt("my_tool", {}, "st-1")
        assert si1.id == si2.id


# ---------------------------------------------------------------------------
# interrupt_on_call=False (default) — legacy pending_halt, no interrupt outcome
# ---------------------------------------------------------------------------

class TestLegacyPendingHaltUnchanged:
    THREAD = "legacy-halt-thread"
    TOOL = Tool(name="my_tool", description="d", parameters={})

    async def test_run_finished_outcome_is_success_by_default(self):
        """Without interrupt_on_call, RunFinished.outcome is RunFinishedSuccessOutcome."""
        # Default ToolBehavior — no interrupt_on_call; stream ends with end_turn
        stream = [
            {"current_tool_use": {"name": "my_tool", "toolUseId": "st-1", "input": {}}},
            {"event": {"contentBlockStop": {}}},
            {"result": _FakeAgentResult(stop_reason="end_turn")},
        ]
        agent = _build_agent(self.THREAD, stream)
        events = await _collect(agent, _run_input(self.THREAD, tools=[self.TOOL]))

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        assert len(finished) == 1
        assert not isinstance(finished[0].outcome, RunFinishedInterruptOutcome)


# ---------------------------------------------------------------------------
# Normal run (no frontend tool) — success outcome
# ---------------------------------------------------------------------------

class TestSuccessOutcomeOnNormalRun:
    THREAD = "success-thread"

    async def test_run_finished_has_success_outcome(self):
        agent = _build_agent(self.THREAD, _empty_stream())
        events = await _collect(agent, _run_input(self.THREAD))

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        assert len(finished) == 1
        assert isinstance(finished[0].outcome, RunFinishedSuccessOutcome)


# ---------------------------------------------------------------------------
# Resume: resolved + approved
# ---------------------------------------------------------------------------

class TestResumeResolvedApproved:
    THREAD = "resume-approved-thread"
    TOOL = Tool(name="my_tool", description="d", parameters={})

    def _config(self) -> StrandsAgentConfig:
        return StrandsAgentConfig(
            tool_behaviors={"my_tool": ToolBehavior(interrupt_on_call=True)}
        )

    async def test_resume_approved_ends_with_success(self):
        strands_interrupt = _make_strands_interrupt("my_tool", {}, "st-1")
        interrupt_state = _make_interrupt_state(
            activated=True,
            interrupts={strands_interrupt.id: strands_interrupt},
        )

        # Second turn stream: normal completion
        resume_stream = [
            {"result": _FakeAgentResult(stop_reason="end_turn")},
        ]

        agent = _build_agent(self.THREAD, resume_stream, self._config(), interrupt_state)

        resume_input = _run_input(
            self.THREAD,
            tools=[self.TOOL],
            resume=[ResumeEntry(
                interrupt_id=strands_interrupt.id,
                status="resolved",
                payload={"approved": True},
            )],
        )
        events = await _collect(agent, resume_input)

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        assert len(finished) == 1
        assert isinstance(finished[0].outcome, RunFinishedSuccessOutcome)

    async def test_resume_approved_passes_y_to_strands(self):
        """Verify stream_async is called with interruptResponse containing 'y'."""
        strands_interrupt = _make_strands_interrupt("my_tool", {}, "st-1")
        interrupt_state = _make_interrupt_state(
            activated=True,
            interrupts={strands_interrupt.id: strands_interrupt},
        )

        received_prompts: list = []

        async def _capture_stream(prompt: Any):
            received_prompts.append(prompt)
            yield {"result": _FakeAgentResult(stop_reason="end_turn")}

        agent = _build_agent(self.THREAD + "-y", [], self._config(), interrupt_state)
        agent._agents_by_thread[self.THREAD + "-y"].stream_async = _capture_stream

        resume_input = _run_input(
            self.THREAD + "-y",
            resume=[ResumeEntry(
                interrupt_id=strands_interrupt.id,
                status="resolved",
                payload={"approved": True},
            )],
        )
        await _collect(agent, resume_input)

        assert len(received_prompts) == 1
        prompt = received_prompts[0]
        assert isinstance(prompt, list)
        assert prompt[0]["interruptResponse"]["response"] == {"approved": True}
        assert prompt[0]["interruptResponse"]["interruptId"] == strands_interrupt.id

    async def test_resume_denied_passes_n_to_strands(self):
        """Verify stream_async is called with interruptResponse containing 'n'."""
        strands_interrupt = _make_strands_interrupt("my_tool", {}, "st-1")
        interrupt_state = _make_interrupt_state(
            activated=True,
            interrupts={strands_interrupt.id: strands_interrupt},
        )

        received_prompts: list = []

        async def _capture_stream(prompt: Any):
            received_prompts.append(prompt)
            yield {"result": _FakeAgentResult(stop_reason="end_turn")}

        agent = _build_agent(self.THREAD + "-n", [], self._config(), interrupt_state)
        agent._agents_by_thread[self.THREAD + "-n"].stream_async = _capture_stream

        resume_input = _run_input(
            self.THREAD + "-n",
            resume=[ResumeEntry(
                interrupt_id=strands_interrupt.id,
                status="resolved",
                payload={"approved": False},
            )],
        )
        await _collect(agent, resume_input)

        assert received_prompts[0][0]["interruptResponse"]["response"] == {"approved": False}

    async def test_resume_passes_prompt_when_replay_history_enabled(self):
        """When replay_history=True (no session_manager), resume still passes interruptResponse."""
        strands_interrupt = _make_strands_interrupt("my_tool", {}, "st-1")
        interrupt_state = _make_interrupt_state(
            activated=True,
            interrupts={strands_interrupt.id: strands_interrupt},
        )

        received_prompts: list = []

        async def _capture_stream(prompt: Any):
            received_prompts.append(prompt)
            yield {"result": _FakeAgentResult(stop_reason="end_turn")}

        agent = _build_agent(self.THREAD + "-replay", [], self._config(), interrupt_state)
        inner = agent._agents_by_thread[self.THREAD + "-replay"]
        inner.session_manager = None  # Force replay_history=True
        inner.stream_async = _capture_stream

        resume_input = _run_input(
            self.THREAD + "-replay",
            resume=[ResumeEntry(
                interrupt_id=strands_interrupt.id,
                status="resolved",
                payload={"approved": True},
            )],
        )
        await _collect(agent, resume_input)

        assert len(received_prompts) == 1
        assert received_prompts[0] is not None
        assert received_prompts[0][0]["interruptResponse"]["interruptId"] == strands_interrupt.id
        assert received_prompts[0][0]["interruptResponse"]["response"] == {"approved": True}


# ---------------------------------------------------------------------------
# Resume: cancelled
# ---------------------------------------------------------------------------

class TestResumeCancelled:
    THREAD = "resume-cancelled-thread"
    TOOL = Tool(name="my_tool", description="d", parameters={})

    def _config(self) -> StrandsAgentConfig:
        return StrandsAgentConfig(
            tool_behaviors={"my_tool": ToolBehavior(interrupt_on_call=True)}
        )

    async def test_cancelled_resume_ends_cleanly(self):
        strands_interrupt = _make_strands_interrupt("my_tool", {}, "st-1")
        interrupt_state = _make_interrupt_state(
            activated=True,
            interrupts={strands_interrupt.id: strands_interrupt},
        )

        agent = _build_agent(self.THREAD, [], self._config(), interrupt_state)

        resume_input = _run_input(
            self.THREAD,
            resume=[ResumeEntry(interrupt_id=strands_interrupt.id, status="cancelled")],
        )
        events = await _collect(agent, resume_input)

        errors = [e for e in events if e.type == EventType.RUN_ERROR]
        assert len(errors) == 0

        finished = [e for e in events if e.type == EventType.RUN_FINISHED]
        assert len(finished) == 1
        assert isinstance(finished[0].outcome, RunFinishedSuccessOutcome)

    async def test_cancelled_calls_deactivate(self):
        strands_interrupt = _make_strands_interrupt("my_tool", {}, "st-1")
        interrupt_state = _make_interrupt_state(
            activated=True,
            interrupts={strands_interrupt.id: strands_interrupt},
        )

        agent = _build_agent(self.THREAD + "-deact", [], self._config(), interrupt_state)

        resume_input = _run_input(
            self.THREAD + "-deact",
            resume=[ResumeEntry(interrupt_id=strands_interrupt.id, status="cancelled")],
        )
        await _collect(agent, resume_input)

        interrupt_state.deactivate.assert_called_once()


# ---------------------------------------------------------------------------
# Resume: unknown interrupt_id
# ---------------------------------------------------------------------------

class TestResumeUnknownInterruptId:
    THREAD = "unknown-id-thread"
    TOOL = Tool(name="my_tool", description="d", parameters={})

    def _config(self) -> StrandsAgentConfig:
        return StrandsAgentConfig(
            tool_behaviors={"my_tool": ToolBehavior(interrupt_on_call=True)}
        )

    async def test_unknown_id_yields_run_error(self):
        strands_interrupt = _make_strands_interrupt("my_tool", {}, "st-1")
        interrupt_state = _make_interrupt_state(
            activated=True,
            interrupts={strands_interrupt.id: strands_interrupt},
        )

        agent = _build_agent(self.THREAD, [], self._config(), interrupt_state)

        resume_input = _run_input(
            self.THREAD,
            resume=[ResumeEntry(interrupt_id="wrong-id", status="resolved", payload={"approved": True})],
        )
        events = await _collect(agent, resume_input)

        errors = [e for e in events if e.type == EventType.RUN_ERROR]
        assert len(errors) == 1
        assert errors[0].code == "UNKNOWN_INTERRUPT_ID"

    async def test_no_pending_interrupt_yields_run_error(self):
        """Resume on a thread with no active interrupt must yield RunError."""
        # interrupt_state.activated = False → no pending interrupt
        interrupt_state = _make_interrupt_state(activated=False)

        agent = _build_agent(self.THREAD + "-none", [], self._config(), interrupt_state)

        resume_input = _run_input(
            self.THREAD + "-none",
            resume=[ResumeEntry(interrupt_id="any-id", status="resolved", payload={"approved": True})],
        )
        events = await _collect(agent, resume_input)

        errors = [e for e in events if e.type == EventType.RUN_ERROR]
        assert len(errors) == 1
        assert errors[0].code == "UNKNOWN_INTERRUPT_ID"


# ---------------------------------------------------------------------------
# StrandsInterruptHook auto-registration
# ---------------------------------------------------------------------------

class TestStrandsInterruptHookAutoRegistration:
    async def test_hook_prepended_when_interrupt_on_call_tools_present(self):
        from ag_ui_strands.agent import StrandsInterruptHook
        config = StrandsAgentConfig(
            tool_behaviors={"my_tool": ToolBehavior(interrupt_on_call=True)}
        )
        agent = StrandsAgent(_template_agent(), name="test", config=config)
        assert len(agent._hooks) >= 1
        assert isinstance(agent._hooks[0], StrandsInterruptHook)

    async def test_no_hook_when_no_interrupt_on_call_tools(self):
        from ag_ui_strands.agent import StrandsInterruptHook
        config = StrandsAgentConfig(
            tool_behaviors={"my_tool": ToolBehavior(stop_streaming_after_result=True)}
        )
        agent = StrandsAgent(_template_agent(), name="test", config=config)
        assert not any(isinstance(h, StrandsInterruptHook) for h in agent._hooks)

    async def test_hook_prepended_before_caller_hooks(self):
        from ag_ui_strands.agent import StrandsInterruptHook
        caller_hook = MagicMock()
        config = StrandsAgentConfig(
            tool_behaviors={"my_tool": ToolBehavior(interrupt_on_call=True)}
        )
        agent = StrandsAgent(_template_agent(), name="test", config=config, hooks=[caller_hook])
        assert isinstance(agent._hooks[0], StrandsInterruptHook)
        assert agent._hooks[1] is caller_hook



