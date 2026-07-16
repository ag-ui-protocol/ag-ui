"""Regression tests for the direct-translator example server."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

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
def test_a_request_without_a_valid_decision_starts_a_fresh_run(
    forwarded_props: Any,
    endpoint: Any,
    store: dict[str, object],
) -> None:
    # Both servers answer normally instead of refusing the request: a user who
    # types something else instead of deciding abandons the paused run, and a
    # thread that lost its approval card can still be talked to.
    store.clear()
    store["thread_1"] = _PendingState()

    try:
        response = asyncio.run(endpoint(_run_input(forwarded_props)))

        assert response.status_code == 200
        assert store == {}
    finally:
        store.clear()


def test_approval_stream_error_keeps_what_already_streamed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The hand-drain is the only place an SDK failure can land outside
    # to_agui's wrapper. Re-raising it from the replay puts it back inside, so
    # the client still gets the events that made it out before the failure —
    # and one RUN_ERROR, built by the translator like on every other route.
    boom = RuntimeError("provider exploded")

    async def stream_events():
        yield "event_1"
        raise boom

    result = SimpleNamespace(
        stream_events=stream_events,
        interruptions=[],
        to_state=lambda: None,
    )
    monkeypatch.setattr(
        translator_server.Runner, "run_streamed", lambda *a, **k: result
    )

    seen: dict[str, Any] = {}

    async def to_agui(events: Any, body: Any, **kwargs: Any):
        seen["replayed"] = [event async for event in _drain(events, seen)]
        yield SimpleNamespace(type="RUN_ERROR")

    async def _drain(events: Any, sink: dict[str, Any]):
        try:
            async for event in events:
                yield event
        except RuntimeError as exc:
            sink["raised"] = exc

    monkeypatch.setattr(
        translator_server,
        "translator",
        SimpleNamespace(
            to_openai=lambda run_input: SimpleNamespace(
                messages=[], tools=[], context=[]
            ),
            to_agui=to_agui,
        ),
    )

    async def collect() -> list[Any]:
        return [
            chunk
            async for chunk in translator_server._stream_approval(
                SimpleNamespace(agent=SimpleNamespace(tools=[])),
                _run_input(),
                None,
                None,
                False,
            )
        ]

    asyncio.run(collect())

    assert seen["replayed"] == ["event_1"], "partial output must survive the failure"
    assert seen["raised"] is boom, "the error must reach to_agui, not be swallowed"


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
