"""RUN_STARTED declares the AG-UI protocol version this adapter speaks.

AG-UI 1.0 has a producer put ``protocolVersion`` on RUN_STARTED so a client
can tell which contract the stream follows. These tests drive the paths a
RUN_STARTED can come from, the normal run, an early refusal and the
endpoint's synthesized opening frame, and check the field on the wire. A
source scan then makes sure no ``RunStartedEvent`` construction leaves it off.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Any, AsyncIterator
from unittest.mock import MagicMock, patch

import pytest
from ag_ui.core import PROTOCOL_VERSION, BaseEvent, EventType, RunAgentInput
from fastapi import FastAPI
from fastapi.testclient import TestClient
from strands.agent.state import AgentState
from strands.hooks.registry import HookRegistry

import ag_ui_strands
from ag_ui_strands.agent import StrandsAgent, _error_events
from ag_ui_strands.config import StrandsAgentConfig
from ag_ui_strands.endpoint import add_strands_fastapi_endpoint

from tests.endpoint_helpers import sse_payloads, valid_run_input
from tests.interrupt_state_stub import InterruptStateStub


def test_the_sdk_this_adapter_targets_is_protocol_1_0():
    assert PROTOCOL_VERSION == "1.0"


class _EmptyCore:
    """The per-thread agent surface the adapter reads, streaming nothing."""

    def __init__(self) -> None:
        self.agent_id = "default"
        self.tool_registry = MagicMock()
        self.tool_registry.registry = {}
        self.state = AgentState()
        self.model = MagicMock()
        self.messages: list = []
        self.hooks = HookRegistry()
        self.session_manager = None
        self._interrupt_state = InterruptStateStub()

    async def stream_async(self, prompt):
        return
        yield  # pragma: no cover


def _adapter() -> StrandsAgent:
    template = MagicMock()
    template.model = MagicMock()
    template.system_prompt = "You are a test assistant."
    template.tool_registry = MagicMock()
    template.tool_registry.registry = {}
    return StrandsAgent(
        agent=template,
        name="protocol-version-agent",
        config=StrandsAgentConfig(replay_history_into_strands=False),
    )


def _run_input() -> RunAgentInput:
    return RunAgentInput(
        thread_id="protocol-version-thread",
        run_id="run-1",
        state={},
        messages=[],
        tools=[],
        context=[],
        forwarded_props={},
    )


@pytest.mark.asyncio
async def test_a_normal_run_opens_with_the_protocol_version():
    with patch("ag_ui_strands.agent.StrandsAgentCore", return_value=_EmptyCore()):
        events = [event async for event in _adapter().run(_run_input())]

    started = events[0]
    assert started.type == EventType.RUN_STARTED
    assert started.protocol_version == "1.0"
    wire = started.model_dump(by_alias=True, exclude_none=True)
    assert wire["protocolVersion"] == "1.0"


def test_an_early_refusal_opens_with_the_protocol_version():
    started, error = _error_events(_run_input(), "refused", "SOME_CODE")

    assert started.type == EventType.RUN_STARTED
    assert started.protocol_version == "1.0"
    assert error.type == EventType.RUN_ERROR


class _FailsBeforeYielding:
    name = "immediate"

    async def run(self, input_data: Any) -> AsyncIterator[BaseEvent]:
        raise RuntimeError("failed on entry")
        yield  # pragma: no cover


def test_the_endpoint_synthesized_run_started_carries_the_protocol_version():
    app = FastAPI()
    add_strands_fastapi_endpoint(app, _FailsBeforeYielding(), "/")

    response = TestClient(app).post("/", json=valid_run_input())

    frames = sse_payloads(response.text)
    assert [f["type"] for f in frames] == [EventType.RUN_STARTED, EventType.RUN_ERROR]
    assert frames[0]["protocolVersion"] == "1.0"


def test_every_run_started_construction_declares_the_protocol_version():
    package = Path(ag_ui_strands.__file__).parent
    missing: list[str] = []
    found = 0
    for source in sorted(package.rglob("*.py")):
        tree = ast.parse(source.read_text(), filename=str(source))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "RunStartedEvent"
            ):
                found += 1
                if "protocol_version" not in {kw.arg for kw in node.keywords}:
                    missing.append(f"{source.name}:{node.lineno}")

    assert found > 0
    assert missing == []
