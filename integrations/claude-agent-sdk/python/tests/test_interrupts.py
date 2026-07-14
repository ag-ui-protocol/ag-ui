"""Tests for the AG-UI interrupt/resume bridge in the Claude adapter.

The bridge wraps the Claude SDK ``defer`` primitive: a deferred tool halts the
run, and the adapter surfaces it as an AG-UI ``RunFinishedInterruptOutcome``.
Resume verdicts arriving on ``RunAgentInput.resume[]`` are recorded so the
caller's re-fired PreToolUse hook can allow (frozen args) or deny the call.

These tests exercise the pure translation + verdict-recording logic; no LLM or
SessionWorker is involved.
"""

import pytest

from ag_ui.core import (
    RunAgentInput,
    ResumeEntry,
    Interrupt,
    RunFinishedInterruptOutcome,
    Tool,
)
from claude_agent_sdk.types import DeferredToolUse

from ag_ui_claude_sdk.adapter import ClaudeAgentAdapter
from ag_ui_claude_sdk.interrupts import (
    deferred_tool_use_to_interrupt,
    interrupt_id_for_tool_use,
    tool_use_id_from_interrupt_id,
    INTERRUPT_REASON_TOOL_CALL,
)


def _deferred(tool_id="toolu_1", name="delete_file", args=None):
    return DeferredToolUse(id=tool_id, name=name, input=args or {"path": "/etc/hosts"})


def _resume_input(thread_id, entries, run_id="run-2"):
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        messages=[],
        tools=[],
        state=None,
        context=[],
        forwarded_props={},
        resume=entries,
    )


class TestInterruptIdRoundTrip:
    def test_id_prefix_and_inverse(self):
        iid = interrupt_id_for_tool_use("toolu_abc")
        assert iid == "interrupt_toolu_abc"
        assert tool_use_id_from_interrupt_id(iid) == "toolu_abc"

    def test_bare_id_passes_through(self):
        # A client that sends a bare tool_call_id must not break resume.
        assert tool_use_id_from_interrupt_id("toolu_bare") == "toolu_bare"


class TestDeferredToolUseToInterrupt:
    def test_maps_frozen_call_to_interrupt(self):
        interrupt = deferred_tool_use_to_interrupt(_deferred())
        assert isinstance(interrupt, Interrupt)
        assert interrupt.reason == INTERRUPT_REASON_TOOL_CALL
        # interrupt id (approval-request id) is distinct from tool_call_id.
        assert interrupt.tool_call_id == "toolu_1"
        assert interrupt.id == "interrupt_toolu_1"
        assert interrupt.id != interrupt.tool_call_id
        assert interrupt.metadata == {"tool_name": "delete_file"}

    def test_response_schema_pulled_from_matching_tool(self):
        schema = {"type": "object", "properties": {"path": {"type": "string"}}}
        tools = [Tool(name="delete_file", description="", parameters=schema)]
        interrupt = deferred_tool_use_to_interrupt(_deferred(), tools=tools)
        assert interrupt.response_schema == schema

    def test_missing_tool_schema_is_none_not_error(self):
        tools = [Tool(name="other_tool", description="", parameters={})]
        interrupt = deferred_tool_use_to_interrupt(_deferred(), tools=tools)
        assert interrupt.response_schema is None


class TestEmitOutcome:
    def test_emits_interrupt_outcome_when_opted_in(self, make_input):
        adapter = ClaudeAgentAdapter(name="t", emit_interrupt_outcome=True)
        run_result = {"is_error": False, "deferred_tool_use": _deferred()}
        outcome = adapter._build_interrupt_outcome(run_result, make_input())
        assert isinstance(outcome, RunFinishedInterruptOutcome)
        assert outcome.type == "interrupt"
        assert len(outcome.interrupts) == 1
        assert outcome.interrupts[0].tool_call_id == "toolu_1"

    def test_no_outcome_when_opted_out(self, make_input):
        adapter = ClaudeAgentAdapter(name="t", emit_interrupt_outcome=False)
        run_result = {"is_error": False, "deferred_tool_use": _deferred()}
        assert adapter._build_interrupt_outcome(run_result, make_input()) is None

    def test_no_outcome_when_no_deferred_call(self, make_input):
        adapter = ClaudeAgentAdapter(name="t", emit_interrupt_outcome=True)
        run_result = {"is_error": False, "deferred_tool_use": None}
        assert adapter._build_interrupt_outcome(run_result, make_input()) is None

    def test_no_outcome_when_result_missing(self, make_input):
        adapter = ClaudeAgentAdapter(name="t", emit_interrupt_outcome=True)
        assert adapter._build_interrupt_outcome(None, make_input()) is None


class TestResumeIngest:
    def test_resolved_verdict_recorded(self):
        adapter = ClaudeAgentAdapter(name="t", emit_interrupt_outcome=True)
        inp = _resume_input(
            "thread-9",
            [ResumeEntry(interrupt_id="interrupt_toolu_1", status="resolved",
                         payload={"approved": True})],
        )
        adapter._ingest_resume("thread-9", inp)
        verdict = adapter.resume_verdict_for("thread-9", "toolu_1")
        assert verdict is not None
        assert verdict["resolved"] is True
        assert verdict["status"] == "resolved"
        assert verdict["payload"] == {"approved": True}

    def test_cancelled_verdict_not_resolved(self):
        adapter = ClaudeAgentAdapter(name="t", emit_interrupt_outcome=True)
        inp = _resume_input(
            "thread-9",
            [ResumeEntry(interrupt_id="interrupt_toolu_1", status="cancelled")],
        )
        adapter._ingest_resume("thread-9", inp)
        verdict = adapter.resume_verdict_for("thread-9", "toolu_1")
        assert verdict["resolved"] is False

    def test_empty_resume_clears_stale_verdicts(self):
        adapter = ClaudeAgentAdapter(name="t", emit_interrupt_outcome=True)
        adapter._resume_verdicts["thread-9"] = {"toolu_old": {"resolved": True}}
        adapter._ingest_resume("thread-9", _resume_input("thread-9", None))
        assert adapter.resume_verdict_for("thread-9", "toolu_old") is None

    def test_unknown_tool_use_returns_none(self):
        adapter = ClaudeAgentAdapter(name="t", emit_interrupt_outcome=True)
        assert adapter.resume_verdict_for("thread-9", "toolu_missing") is None


class TestSecurityInvariant:
    def test_interrupt_carries_frozen_call_id_not_rederived(self):
        # The interrupt binds to the frozen DeferredToolUse id. Approving it
        # must re-execute THAT call; args are never re-derived from a later
        # model turn. We assert the id binding here; the frozen-args execution
        # is enforced downstream by the caller's PreToolUse allow(updatedInput).
        deferred = _deferred(tool_id="toolu_frozen", args={"path": "/safe"})
        interrupt = deferred_tool_use_to_interrupt(deferred)
        assert interrupt.tool_call_id == "toolu_frozen"
        # The frozen args live on the DeferredToolUse, not on the interrupt,
        # so a resume verdict cannot smuggle replacement args through the wire.
        assert not hasattr(interrupt, "input")
