"""An approval runs once, and only on the agent that paused it.

* A token that expires while an earlier resumed tool is running must not run
  its call again: the record of a decided token is dropped at expiry, so an
  expired token must never count as newly decided.
* A token one agent issued must not run another agent's tool of the same
  name, even with the same secret, store, thread, call id and arguments.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from ag_ui.core import EventType, FunctionCall, ResumeEntry, ToolCall, UserMessage
from agents import Agent, Runner, function_tool
from test_interrupts import ScriptedModel, call, finished, request, run, snapshot, text

from ag_ui_openai_agents import AGUITranslator, ApprovalSigner, OpenAIAgentsAgent, resume_tool_calls
from ag_ui_openai_agents import approvals as approvals_module
from ag_ui_openai_agents.approvals import SECRET_ENV
from ag_ui_openai_agents.interrupts import UNVERIFIED

SECRET = "s" * 32

ran: list[str] = []


class Clock:
    """Stands in for the ``time`` module the signer reads."""

    def __init__(self, now: float) -> None:
        self.now = now

    def time(self) -> float:
        return self.now


clock = Clock(0)


@function_tool(needs_approval=True)
def slow(job: str) -> str:
    """A long job: by the time it ends, the next approval has expired."""
    ran.append(f"slow {job}")
    clock.now = 161
    return "slow done"


@function_tool(needs_approval=True)
def refund(order_id: str) -> str:
    """Move money."""
    ran.append(f"refund {order_id}")
    return "money moved"


@function_tool(name_override="refund", needs_approval=True)
def preview_refund(order_id: str) -> str:
    """Show what a refund would do."""
    ran.append(f"preview {order_id}")
    return "preview only"


class SharedConsumedTokens:
    def __init__(self) -> None:
        self.seen: set[str] = set()

    def consume(self, token_id: str, expires_at: float) -> bool:
        if token_id in self.seen:
            return False
        self.seen.add(token_id)
        return True


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    ran.clear()
    monkeypatch.setattr(approvals_module, "_default", None)


def approve(call_id: str) -> ResumeEntry:
    return ResumeEntry(interrupt_id=call_id, status="resolved", payload={"approved": True})


def tool_results(events: list[Any]) -> list[tuple[str, str]]:
    return [(e.tool_call_id, e.content) for e in events if e.type == EventType.TOOL_CALL_RESULT]


# ── a token that expires while an earlier tool runs ──────────────────────


def test_a_token_that_expires_during_an_earlier_tool_does_not_run_again(monkeypatch):
    monkeypatch.setattr(approvals_module, "time", clock)
    clock.now = 100
    signer = ApprovalSigner(SECRET, ttl_seconds=60)  # tokens issued at 100 expire at 160
    model = ScriptedModel(
        [call("slow", {"job": "J1"}, "slow1"), call("refund", {"order_id": "ORD-1"}, "refund1")],
        [text("Done.")],
    )
    agent = OpenAIAgentsAgent(
        Agent(name="support", instructions="Help.", tools=[slow, refund], model=model),
        approvals=signer,
    )
    paused = snapshot(run(agent, request([UserMessage(id="u1", role="user", content="go")])))

    # The refund is approved and runs; the slow job stays open.
    clock.now = 110
    first = run(agent, request(paused, resume=[approve("refund1")]))
    assert tool_results(first) == [("refund1", "money moved")]

    # The original paused history again, both approved, before expiry. The
    # slow job runs past the refund token's expiry.
    clock.now = 155
    replay = run(agent, request(paused, resume=[approve("slow1"), approve("refund1")]))

    assert ran == ["refund ORD-1", "slow J1"]
    assert ("refund1", "money moved") not in tool_results(replay)


@pytest.mark.parametrize("expires_in", [0, -1])
def test_an_expired_token_is_never_consumed(monkeypatch, expires_in):
    monkeypatch.setattr(approvals_module, "time", clock)
    clock.now = 1000
    signer = ApprovalSigner(SECRET)
    held = approvals_module.HeldCall(token_id="jti", expires_at=1000 + expires_in)


    assert asyncio.run(signer.consume(held)) is False


def test_a_token_that_expires_while_an_async_store_answers_is_not_consumed(monkeypatch):
    monkeypatch.setattr(approvals_module, "time", clock)
    clock.now = 100

    class SlowStore:
        async def consume(self, token_id: str, expires_at: float) -> bool:
            clock.now = expires_at + 1
            return True


    signer = ApprovalSigner(SECRET, consumed=SlowStore())
    held = approvals_module.HeldCall(token_id="jti", expires_at=150)
    assert asyncio.run(signer.consume(held)) is False


# ── a token is scoped to the agent that paused the call ──────────────────


def _agent(name: str, tool: Any, *turns: list[Any], store: Any, **kwargs: Any) -> OpenAIAgentsAgent:
    model = ScriptedModel(*turns)
    sdk_agent = Agent(name=name, instructions="Help.", tools=[tool], model=model)
    return OpenAIAgentsAgent(sdk_agent, consumed_tokens=store, **kwargs)


def test_a_token_from_one_agent_does_not_run_another_agents_tool_of_the_same_name(monkeypatch):
    monkeypatch.setenv(SECRET_ENV, SECRET)
    store = SharedConsumedTokens()
    sandbox = _agent("sandbox", preview_refund, [call("refund", {"order_id": "ORD-1"}, "c1")], store=store)
    production = _agent("production", refund, [text("Done.")], store=store)

    paused = snapshot(run(sandbox, request([UserMessage(id="u1", role="user", content="refund")])))
    events = run(production, request(paused, resume=[approve("c1")]))

    assert ran == []
    assert tool_results(events) == [("c1", UNVERIFIED)]


def test_an_explicit_scope_separates_agents_that_share_a_name(monkeypatch):
    monkeypatch.setenv(SECRET_ENV, SECRET)
    store = SharedConsumedTokens()
    sandbox = _agent(
        "support",
        preview_refund,
        [call("refund", {"order_id": "ORD-1"}, "c1")],
        store=store,
        approval_scope="sandbox",
    )
    production = _agent("support", refund, [text("Done.")], store=store, approval_scope="production")

    paused = snapshot(run(sandbox, request([UserMessage(id="u1", role="user", content="refund")])))
    events = run(production, request(paused, resume=[approve("c1")]))

    assert ran == []
    assert tool_results(events) == [("c1", UNVERIFIED)]


def test_another_worker_serving_the_same_agent_accepts_the_token(monkeypatch):
    monkeypatch.setenv(SECRET_ENV, SECRET)
    store = SharedConsumedTokens()
    worker_a = _agent("support", refund, [call("refund", {"order_id": "ORD-1"}, "c1")], store=store)
    worker_b = _agent("support", refund, [text("Done.")], store=store)

    paused = snapshot(run(worker_a, request([UserMessage(id="u1", role="user", content="refund")])))
    events = run(worker_b, request(paused, resume=[approve("c1")]))

    assert finished(events).outcome.type == "success"
    assert ran == ["refund ORD-1"]


def test_a_signer_scope_is_bound_into_the_token():
    sandbox = ApprovalSigner(SECRET, scope="sandbox")
    production = sandbox.scoped("production")

    tool_call = ToolCall(id="c1", type="function", function=FunctionCall(name="refund", arguments="{}"))
    held = sandbox.hold("t1", tool_call)

    assert sandbox.verify("t1", held) is not None
    assert production.verify("t1", held) is None
    assert production.scope == "production"


# ── the translator needs a scope to pause or resume an approval ──────────


def _translate(sdk_agent: Agent, run_input: Any, **kwargs: Any) -> list[Any]:
    """Run ``sdk_agent`` and translate its stream, as a translator user does."""
    translator = AGUITranslator()
    translated = translator.to_openai(run_input)
    events: list[Any] = []

    async def collect():
        result = Runner.run_streamed(sdk_agent, input=translated.messages)
        async for event in translator.to_agui(result, run_input, **kwargs):
            events.append(event)

    try:
        asyncio.run(collect())
    except ValueError:
        pass  # to_agui re-raises after RUN_ERROR
    return events


def _sandbox_and_production() -> tuple[Agent, Agent]:
    sandbox = Agent(
        name="sandbox",
        instructions="Help.",
        tools=[preview_refund],
        model=ScriptedModel([call("refund", {"order_id": "ORD-1"}, "c1")]),
    )
    production = Agent(name="production", instructions="Help.", tools=[refund])
    return sandbox, production


def test_the_translator_without_a_scoped_signer_lets_no_other_agent_run_the_call(monkeypatch):
    # The probe from review: the sandbox run is translated with no signer, and
    # its genuine snapshot is resumed on production, also with no signer.
    monkeypatch.setenv(SECRET_ENV, SECRET)
    sandbox, production = _sandbox_and_production()

    events = _translate(sandbox, request([UserMessage(id="u1", role="user", content="refund")]))
    snapshots = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT]
    if snapshots:
        resumed = asyncio.run(
            resume_tool_calls(production, request(snapshots[-1].messages, resume=[approve("c1")]))
        )
        assert tool_results(resumed.tool_results) == [("c1", UNVERIFIED)]

    assert ran == []
    # Fail closed: the pause is refused, not signed with an empty scope.
    assert events[-1].type == EventType.RUN_ERROR
    assert "scope" in events[-1].message


def test_a_signer_without_a_scope_neither_issues_nor_verifies():
    unscoped = ApprovalSigner(SECRET)
    tool_call = ToolCall(id="c1", type="function", function=FunctionCall(name="refund", arguments="{}"))

    with pytest.raises(ValueError, match="scope"):
        unscoped.issue("t1", tool_call)

    # A token with an empty scope, signed with the right secret (as the
    # previous release issued them), is refused too.
    payload = {
        "v": 1,
        "aud": "",
        "tid": "t1",
        "tcid": "c1",
        "name": "refund",
        "ah": approvals_module._arguments_hash("{}"),
        "exp": 2**40,
        "jti": "j",
    }
    body = approvals_module._b64(json.dumps(payload, separators=(",", ":")).encode())
    token = f"{body}.{approvals_module._b64(unscoped._sign(body))}"
    forged = tool_call.model_copy(update={"metadata": {"ag-ui": {"heldCall": token}}})
    assert unscoped.verify("t1", forged) is None


def test_the_translator_with_a_scoped_signer_resumes_on_that_agent_only(monkeypatch):
    monkeypatch.setenv(SECRET_ENV, SECRET)
    store = SharedConsumedTokens()
    base = approvals_module.default_approval_signer(consumed=store)
    sandbox, production = _sandbox_and_production()

    events = _translate(
        sandbox,
        request([UserMessage(id="u1", role="user", content="refund")]),
        approvals=base.scoped(sandbox.name),
    )
    assert finished(events).outcome.type == "interrupt"
    history = snapshot(events)

    elsewhere = asyncio.run(
        resume_tool_calls(production, request(history, resume=[approve("c1")]), approvals=base.scoped(production.name))
    )
    assert tool_results(elsewhere.tool_results) == [("c1", UNVERIFIED)]
    assert ran == []

    here = asyncio.run(
        resume_tool_calls(sandbox, request(history, resume=[approve("c1")]), approvals=base.scoped(sandbox.name))
    )
    assert tool_results(here.tool_results) == [("c1", "preview only")]
    assert ran == ["preview ORD-1"]
