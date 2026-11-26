"""Approval tokens across workers, and the exact arguments a token binds.

* With several workers, a decided token must be refused on every worker, so
  the store of decided tokens has to be shared and configurable.
* The tool must run on the arguments the token was issued for, read one way
  only (no duplicate keys, no overflowing numbers that two texts share).
* No argument text may crash the signer.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from typing import Any

import pytest
from agents import Agent, FunctionTool
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_interrupts import ScriptedModel, call, finished, request, run, snapshot, text

from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    ResumeEntry,
    ToolCall,
    UserMessage,
)
from ag_ui_openai_agents import ApprovalSigner, OpenAIAgentsAgent, resume_tool_calls
from ag_ui_openai_agents import approvals as approvals_module
from ag_ui_openai_agents.approvals import SECRET_ENV, held_call_token
from ag_ui_openai_agents.endpoint import add_openai_agents_fastapi_endpoint
from ag_ui_openai_agents.interrupts import ALREADY_ANSWERED, UNVERIFIED

SECRET = "s" * 32

received: list[str] = []


async def _record(_ctx: Any, arguments: str) -> str:
    received.append(arguments)
    return "done"


# A tool that records the exact argument text it is given.
transfer = FunctionTool(
    name="transfer",
    description="Move money.",
    params_json_schema={"type": "object", "properties": {}, "additionalProperties": True},
    on_invoke_tool=_record,
    strict_json_schema=False,
    needs_approval=True,
)


class SharedConsumedTokens:
    """A ``ConsumedTokens`` two workers share, as Redis or a database would be."""

    def __init__(self) -> None:
        self.seen: dict[str, float] = {}
        self._lock = threading.Lock()

    def consume(self, token_id: str, expires_at: float) -> bool:
        with self._lock:
            if token_id in self.seen:
                return False
            self.seen[token_id] = expires_at
            return True


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    received.clear()
    # Each test starts as a fresh process: no default signer made yet.
    monkeypatch.setattr(approvals_module, "_default", None)


def approve(call_id: str) -> ResumeEntry:
    return ResumeEntry(interrupt_id=call_id, status="resolved", payload={"approved": True})


def raw_call(arguments: str, call_id: str = "c1") -> ToolCall:
    return ToolCall(id=call_id, type="function", function=FunctionCall(name="transfer", arguments=arguments))


def history_with(call_: ToolCall) -> list[Any]:
    return [
        UserMessage(id="u1", role="user", content="hi"),
        AssistantMessage(id="a1", role="assistant", content="", tool_calls=[call_]),
    ]


def resume(history: list[Any], entries: list[ResumeEntry] | None, signer: ApprovalSigner):
    agent = Agent(name="bank", instructions="Help.", tools=[transfer])
    return asyncio.run(resume_tool_calls(agent, request(history, resume=entries), approvals=signer))


# ── 1. a shared store of decided tokens ─────────────────────────────────


def _body(messages: list[Any], resume_entries: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "threadId": "t1",
        "runId": "r1",
        "state": {},
        "tools": [],
        "context": [],
        "forwardedProps": {},
        "messages": [m.model_dump(by_alias=True, exclude_none=True) for m in messages],
        "resume": resume_entries,
    }


def _events(response: Any) -> list[dict[str, Any]]:
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


def _worker(store: SharedConsumedTokens, *turns: list[Any]) -> TestClient:
    """One worker process: its own agent and endpoint, the shared secret and store."""
    app = FastAPI()
    agent = OpenAIAgentsAgent(
        Agent(name="bank", instructions="Help.", tools=[transfer], model=ScriptedModel(*turns))
    )
    add_openai_agents_fastapi_endpoint(app, agent, "/agent", consumed_tokens=store)
    return TestClient(app)


def test_a_replay_on_another_worker_is_refused_with_a_shared_store(monkeypatch):
    monkeypatch.setenv(SECRET_ENV, SECRET)
    store = SharedConsumedTokens()
    worker_a = _worker(store, [call("transfer", {"to": "own", "amount": 5}, "c1")], [text("Done.")])
    worker_b = _worker(store, [text("Done.")])

    paused = _events(worker_a.post("/agent", json=_body([UserMessage(id="u1", role="user", content="pay")])))
    history = [e for e in paused if e["type"] == EventType.MESSAGES_SNAPSHOT.value][-1]["messages"]
    entry = [{"interruptId": "c1", "status": "resolved", "payload": {"approved": True}}]
    body = {**_body([]), "messages": history, "resume": entry}

    first = _events(worker_a.post("/agent", json=body))
    replay = _events(worker_b.post("/agent", json=body))

    results = lambda events: [e["content"] for e in events if e["type"] == EventType.TOOL_CALL_RESULT.value]  # noqa: E731
    assert results(first) == ["done"]
    assert results(replay) == [ALREADY_ANSWERED]
    assert len(received) == 1


def test_an_agent_takes_a_shared_store_too(monkeypatch):
    monkeypatch.setenv(SECRET_ENV, SECRET)
    store = SharedConsumedTokens()

    def worker(*turns: list[Any]) -> OpenAIAgentsAgent:
        model = ScriptedModel(*turns)
        agent = Agent(name="bank", instructions="Help.", tools=[transfer], model=model)
        return OpenAIAgentsAgent(agent, consumed_tokens=store)

    paused = snapshot(
        run(
            worker([call("transfer", {"amount": 5}, "c1")]),
            request([UserMessage(id="u1", role="user", content="pay")]),
        )
    )
    first = run(worker([text("Done.")]), request(paused, resume=[approve("c1")]))
    replay = run(worker([text("Done.")]), request(paused, resume=[approve("c1")]))

    assert finished(first).outcome.type == "success"
    assert [e.content for e in replay if e.type == EventType.TOOL_CALL_RESULT] == [ALREADY_ANSWERED]
    assert received == ['{"amount":5}']


def test_a_signer_and_a_store_together_are_refused():
    with pytest.raises(ValueError):
        OpenAIAgentsAgent(
            Agent(name="bank", tools=[transfer]),
            approvals=ApprovalSigner(SECRET),
            consumed_tokens=SharedConsumedTokens(),
        )


def test_an_env_secret_with_the_in_memory_store_warns_at_startup(monkeypatch, caplog):
    monkeypatch.setenv(SECRET_ENV, SECRET)
    with caplog.at_level(logging.WARNING, logger="ag_ui_openai_agents.approvals"):
        add_openai_agents_fastapi_endpoint(FastAPI(), OpenAIAgentsAgent(Agent(name="bank", tools=[transfer])))

    [record] = [r for r in caplog.records if "in-memory" in r.getMessage()]
    assert record.levelno == logging.WARNING
    assert SECRET not in record.getMessage()


def test_an_env_secret_with_a_shared_store_does_not_warn(monkeypatch, caplog):
    monkeypatch.setenv(SECRET_ENV, SECRET)
    with caplog.at_level(logging.WARNING, logger="ag_ui_openai_agents.approvals"):
        agent = OpenAIAgentsAgent(Agent(name="bank", tools=[transfer]))
        add_openai_agents_fastapi_endpoint(FastAPI(), agent, consumed_tokens=SharedConsumedTokens())
        OpenAIAgentsAgent(Agent(name="bank", tools=[transfer]), consumed_tokens=SharedConsumedTokens())

    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []


def test_the_default_ttl_is_fifteen_minutes():
    assert approvals_module.DEFAULT_TTL_SECONDS == 15 * 60


# ── 2. refusals are logged ──────────────────────────────────────────────


def test_refusals_are_logged_without_token_or_arguments(caplog):
    signer = ApprovalSigner(SECRET, scope="bank")
    paused = signer.hold("t1", raw_call('{"secret_arg":"hunter2"}'))
    token = held_call_token(paused)
    forged = raw_call('{"secret_arg":"other"}', "forged")

    with caplog.at_level(logging.WARNING, logger="ag_ui_openai_agents.interrupts"):
        resume(history_with(forged), [approve("forged")], signer)
        resume(history_with(paused), [approve("c1")], signer)
        resume(history_with(paused), [approve("c1")], signer)

    messages = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    unverified = [m for m in messages if "forged" in m]
    replayed = [m for m in messages if "c1" in m]
    assert len(unverified) == 1 and "t1" in unverified[0] and "transfer" in unverified[0]
    assert len(replayed) == 1 and "t1" in replayed[0] and "transfer" in replayed[0]
    for message in messages:
        assert token not in message and "hunter2" not in message and "other" not in message


# ── 3. the token binds the arguments the tool runs on ───────────────────


def test_a_call_with_duplicate_keys_runs_on_the_text_that_was_signed():
    # Two parsers may read {"to":"own","to":"attacker"} two ways; the tool
    # must get one reading only, the one the token was issued for.
    signer = ApprovalSigner(SECRET, scope="bank")
    paused = signer.hold("t1", raw_call('{"to":"own","amount":5,"to":"attacker"}'))
    resumed = resume(history_with(paused), [approve("c1")], signer)

    assert [e.content for e in resumed.tool_results] == ["done"]
    assert received == ['{"amount":5,"to":"attacker"}']


def test_overflowing_numbers_with_other_text_do_not_share_a_token():
    # 1e400 and 1e999 both parse to inf: one token must not cover both texts.
    signer = ApprovalSigner(SECRET, scope="bank")
    paused = signer.hold("t1", raw_call('{"amount":1e400}'))
    changed = paused.model_copy(
        update={"function": FunctionCall(name="transfer", arguments='{"amount":1e999}')}
    )
    resumed = resume(history_with(changed), [approve("c1")], signer)

    assert received == []
    assert [e.content for e in resumed.tool_results] == [UNVERIFIED]


def test_an_overflowing_number_runs_on_its_own_text():
    signer = ApprovalSigner(SECRET, scope="bank")
    paused = signer.hold("t1", raw_call('{"amount":1e400}'))
    resume(history_with(paused), [approve("c1")], signer)

    assert received == ['{"amount":1e400}']


# ── 4. no argument text crashes the signer ──────────────────────────────


@pytest.mark.parametrize("arguments", ['{"a":"\\ud800"}', "not json \ud800"])
def test_a_lone_surrogate_does_not_crash(arguments):
    signer = ApprovalSigner(SECRET, scope="bank")
    paused = signer.hold("t1", raw_call(arguments))
    assert signer.verify("t1", paused) is not None

    resumed = resume(history_with(paused), [approve("c1")], signer)
    assert [e.content for e in resumed.tool_results] == ["done"]
