"""Regression tests for the direct-translator example server."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException

EXAMPLES = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXAMPLES))

import translator_server  # noqa: E402
from agents_examples import human_in_the_loop_approval  # noqa: E402
from ag_ui.core import Context, RunAgentInput, UserMessage  # noqa: E402


class _PendingState:
    def __init__(self, call_id: str = "call_1") -> None:
        self.item = SimpleNamespace(raw_item=SimpleNamespace(call_id=call_id))

    def get_interruptions(self) -> list[Any]:
        return [self.item]


def _run_input(forwarded_props: Any = None) -> RunAgentInput:
    return RunAgentInput(
        thread_id="thread_1",
        run_id="run_1",
        messages=[UserMessage(id="message_1", role="user", content="hello")],
        tools=[],
        state={},
        context=[],
        forwarded_props=forwarded_props,
    )


@pytest.mark.parametrize(
    "forwarded_props",
    [
        None,
        {"approval": {"call_id": "wrong_call", "approve": True}},
        {"approval": {"call_id": "call_1"}},
    ],
)
@pytest.mark.parametrize(
    ("endpoint", "store"),
    [
        (human_in_the_loop_approval.run, human_in_the_loop_approval._pending_approvals),
        (
            lambda body: translator_server.run("human_in_the_loop_approval", body),
            translator_server._PENDING_APPROVALS,
        ),
    ],
)
def test_invalid_approval_keeps_the_pending_run(
    forwarded_props: Any,
    endpoint: Any,
    store: dict[str, object],
) -> None:
    state = _PendingState()
    store.clear()
    store["thread_1"] = state

    try:
        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(endpoint(_run_input(forwarded_props)))

        assert exc_info.value.status_code == 409
        assert store["thread_1"] is state
    finally:
        store.clear()


def test_valid_approval_resolves_the_matching_item() -> None:
    state = _PendingState()

    item, approve = human_in_the_loop_approval._resolve_approval(
        state,
        {"approval": {"call_id": "call_1", "approve": True}},
    )

    assert item is state.item
    assert approve is True


def test_approval_without_a_pending_run_is_rejected() -> None:
    with pytest.raises(HTTPException) as exc_info:
        human_in_the_loop_approval._resolve_approval(
            None,
            {"approval": {"call_id": "call_1", "approve": True}},
        )

    assert exc_info.value.status_code == 409


def test_direct_server_forwards_context_to_the_sdk(monkeypatch: pytest.MonkeyPatch) -> None:
    context = [Context(description="Response language", value="German")]
    body = _run_input()
    body.context = context
    translated = SimpleNamespace(messages=[{"role": "user"}], tools=[], context=context)
    captured: dict[str, Any] = {}
    result = object()

    async def to_agui(*args: Any, **kwargs: Any):
        if False:
            yield None

    fake_translator = SimpleNamespace(
        to_openai=lambda run_input: translated,
        to_agui=to_agui,
    )

    def run_streamed(agent: Any, *, input: Any, context: Any) -> object:
        captured.update(agent=agent, input=input, context=context)
        return result

    monkeypatch.setattr(translator_server, "translator", fake_translator)
    monkeypatch.setattr(translator_server.Runner, "run_streamed", run_streamed)

    demo = SimpleNamespace(
        agent=object(),
        start_custom_event=None,
        end_custom_event=None,
    )

    async def collect() -> list[Any]:
        return [chunk async for chunk in translator_server._stream(demo, body)]

    assert asyncio.run(collect()) == []
    assert captured["context"] is context
