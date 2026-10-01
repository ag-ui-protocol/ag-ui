"""RUN_STARTED must declare the AG-UI protocol version the middleware speaks.

AG-UI 1.0 producers set ``protocolVersion`` on RUN_STARTED so clients can detect the
wire version. ``ADKAgent`` emits RUN_STARTED from several places (the main execution
path plus a handful of synthesized empty terminal pairs); every one must carry it.
"""

from __future__ import annotations

import ast
import inspect
from typing import AsyncGenerator, List

import pytest
import pytest_asyncio

from ag_ui.core import (
    PROTOCOL_VERSION,
    AssistantMessage,
    EventType,
    RunAgentInput,
    RunStartedEvent,
    UserMessage,
)
from ag_ui.encoder import EventEncoder
from ag_ui_adk import ADKAgent
from ag_ui_adk import adk_agent as adk_agent_module
from ag_ui_adk.session_manager import SessionManager

from google.adk.agents import LlmAgent
from google.adk.apps import App
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import InMemorySessionService
from google.genai import types


class _TextLlm(BaseLlm):
    model: str = "protocol-version-llm"

    async def generate_content_async(
        self, llm_request, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="hello")]),
            partial=False,
            turn_complete=True,
        )


@pytest_asyncio.fixture
async def adk():
    SessionManager.reset_instance()
    yield ADKAgent.from_app(
        App(
            name="protocol_version",
            root_agent=LlmAgent(name="ProtocolVersionAgent", model=_TextLlm()),
        ),
        user_id="user_1",
        session_service=InMemorySessionService(),
    )
    SessionManager.reset_instance()


async def _run(adk: ADKAgent, thread_id: str, messages) -> List:
    return [
        event
        async for event in adk.run(
            RunAgentInput(
                thread_id=thread_id,
                run_id="run_1",
                state={},
                messages=messages,
                tools=[],
                context=[],
                forwarded_props={},
            )
        )
    ]


def _run_started(events) -> RunStartedEvent:
    started = [e for e in events if e.type == EventType.RUN_STARTED]
    assert len(started) == 1, f"expected one RUN_STARTED, got {[e.type for e in events]}"
    return started[0]


def test_protocol_version_is_1_0():
    assert PROTOCOL_VERSION == "1.0"


@pytest.mark.asyncio
async def test_execution_run_started_declares_protocol_version(adk):
    events = await _run(adk, "thread_exec", [UserMessage(id="u1", role="user", content="hi")])

    started = _run_started(events)
    assert started.protocol_version == PROTOCOL_VERSION
    assert events[-1].type == EventType.RUN_FINISHED


@pytest.mark.asyncio
async def test_empty_run_started_declares_protocol_version(adk):
    """No unseen messages: the synthesized terminal pair."""
    events = await _run(adk, "thread_empty", [])

    assert [e.type for e in events] == [EventType.RUN_STARTED, EventType.RUN_FINISHED]
    assert _run_started(events).protocol_version == PROTOCOL_VERSION


@pytest.mark.asyncio
async def test_all_batches_skipped_run_started_declares_protocol_version(adk):
    """Every batch skipped: the other synthesized terminal pair."""
    await _run(adk, "thread_skipped", [UserMessage(id="u0", role="user", content="hi")])
    adk._session_manager._processed_message_ids.clear()

    events = await _run(
        adk,
        "thread_skipped",
        [AssistantMessage(id="a1", role="assistant", content="an earlier reply")],
    )

    assert [e.type for e in events] == [EventType.RUN_STARTED, EventType.RUN_FINISHED]
    assert _run_started(events).protocol_version == PROTOCOL_VERSION


@pytest.mark.asyncio
async def test_protocol_version_is_on_the_wire_as_camel_case(adk):
    events = await _run(adk, "thread_wire", [])

    encoded = EventEncoder().encode(_run_started(events))
    assert '"protocolVersion":"1.0"' in encoded


def test_every_run_started_site_passes_protocol_version():
    """Guards the sites that are awkward to reach in a unit test (confirm_changes with
    no trailing messages, buffered partial tool results) and any future site."""
    tree = ast.parse(inspect.getsource(adk_agent_module))
    sites = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "RunStartedEvent"
    ]

    assert sites, "no RunStartedEvent construction found in adk_agent.py"
    missing = [
        node.lineno
        for node in sites
        if not any(
            kw.arg == "protocol_version"
            and isinstance(kw.value, ast.Name)
            and kw.value.id == "PROTOCOL_VERSION"
            for kw in node.keywords
        )
    ]
    assert not missing, f"RunStartedEvent without protocol_version=PROTOCOL_VERSION at lines {missing}"
