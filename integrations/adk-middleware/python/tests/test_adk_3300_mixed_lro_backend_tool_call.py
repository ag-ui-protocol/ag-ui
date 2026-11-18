"""Regression test for ag-ui#3300.

When one ADK event carries both a long-running (client) tool call and a
backend tool call, the backend call was silently dropped: the LRO branch of
``ADKAgent._run_adk_in_background`` only ran ``translate_text_only`` +
``translate_lro_function_calls``, so no TOOL_CALL_START/ARGS/END was ever
emitted for the backend call — and the backend call's later
TOOL_CALL_RESULT arrived for a ``toolCallId`` the client never saw.

See: https://github.com/ag-ui-protocol/ag-ui/issues/3300
"""

import pytest
from types import SimpleNamespace
from unittest.mock import Mock, MagicMock, patch

from ag_ui.core import EventType, RunAgentInput, UserMessage
from google.adk.agents import Agent

from ag_ui_adk import ADKAgent, SessionManager


@pytest.fixture(autouse=True)
def reset_session_manager():
    try:
        SessionManager.reset_instance()
    except RuntimeError:
        pass
    yield
    try:
        SessionManager.reset_instance()
    except RuntimeError:
        pass


@pytest.fixture
def adk_agent():
    mock_agent = Mock(spec=Agent)
    mock_agent.name = "test_agent"
    return ADKAgent(
        adk_agent=mock_agent,
        app_name="test_app",
        user_id="test_user",
        use_in_memory_services=True,
    )


@pytest.fixture
def sample_input():
    return RunAgentInput(
        thread_id="test_thread",
        run_id="test_run",
        messages=[UserMessage(id="msg1", role="user", content="Write a draft and email it")],
        context=[],
        state={},
        tools=[],
        forwarded_props={},
    )


def _mixed_lro_and_backend_event():
    """One final, non-partial ADK event with an LRO call and a backend call.

    Mirrors the ag-ui#3300 report: the model returns a backend tool call
    (``create_draft``) and a long-running client call (``show_email_draft``)
    in the same response; ``long_running_tool_ids`` marks only the client one.
    """
    lro_call = SimpleNamespace(
        id="call-lro-1", name="show_email_draft", args={"draft_id": "d1"}
    )
    backend_call = SimpleNamespace(
        id="call-backend-1", name="create_draft", args={"subject": "Hi"}
    )
    lro_part = SimpleNamespace(text="", function_call=lro_call, thought_signature=None)
    backend_part = SimpleNamespace(
        text="", function_call=backend_call, thought_signature=None
    )

    event = MagicMock()
    event.id = "evt-mixed-3300"
    event.author = "assistant"
    event.partial = False
    event.turn_complete = True
    event.invocation_id = "inv-3300"
    event.actions = None
    event.custom_data = None
    event.content = SimpleNamespace(parts=[lro_part, backend_part])
    event.long_running_tool_ids = ["call-lro-1"]
    event.get_function_calls = lambda: [lro_call, backend_call]
    event.get_function_responses = lambda: []
    event.is_final_response = Mock(return_value=True)
    return event


@pytest.mark.asyncio
async def test_mixed_event_emits_backend_tool_call_too(adk_agent, sample_input):
    """A mixed LRO + backend event must emit TOOL_CALL trios for both calls."""

    class DummyRunner:
        async def run_async(self, *args, **kwargs):
            yield _mixed_lro_and_backend_event()

    with patch.object(adk_agent, "_create_runner", return_value=DummyRunner()):
        events = []
        async for event in adk_agent.run(sample_input):
            events.append(event)

    assert events[0].type == EventType.RUN_STARTED
    assert events[-1].type == EventType.RUN_FINISHED

    tool_starts = [
        (str(e.type).split(".")[-1], getattr(e, "tool_call_id", None))
        for e in events
        if "TOOL_CALL" in str(e.type)
    ]
    starts_by_id = {}
    for kind, tool_call_id in tool_starts:
        starts_by_id.setdefault(tool_call_id, []).append(kind)

    # The LRO (client) call keeps its trio ...
    assert starts_by_id.get("call-lro-1") == [
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
    ], f"LRO call trio missing/wrong: {tool_starts}"
    # ... and the backend call in the SAME event must get one too (ag-ui#3300).
    assert starts_by_id.get("call-backend-1") == [
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
    ], f"backend call trio missing/wrong: {tool_starts}"
