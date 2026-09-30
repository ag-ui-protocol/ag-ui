"""One requested run must have one terminal, even when history spans batches."""

import pytest

from ag_ui.core import EventType, RunAgentInput
from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import InMemorySessionService
from google.genai import types


class FixedModel(BaseLlm):
    """Exercise the real ADK runner without network or tool-data dependencies."""

    model: str = "terminal-order-test"
    fail: bool = False
    calls: int = 0

    async def generate_content_async(self, llm_request, stream=False):
        self.calls += 1
        if self.fail:
            raise RuntimeError("synthetic provider failure")
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="NEW_REPLY")]),
            partial=False,
            turn_complete=True,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("fail", [False, True])
async def test_history_batches_share_one_terminal(fail):
    """A cold message cache can dispatch several batches in one run request."""
    SessionManager.reset_instance()
    model = FixedModel(fail=fail)
    agent = ADKAgent(
        adk_agent=LlmAgent(name="test", model=model),
        app_name="test",
        user_id="user",
        session_service=InMemorySessionService(),
    )
    request = RunAgentInput(
        thread_id="imported-history",
        run_id="continuation",
        state={},
        messages=[
            {"id": "old-user", "role": "user", "content": "old request"},
            {
                "id": "old-assistant",
                "role": "assistant",
                "toolCalls": [
                    {
                        "id": "old-tool",
                        "type": "function",
                        "function": {"name": "show", "arguments": "{}"},
                    }
                ],
            },
            {
                "id": "result",
                "role": "tool",
                "toolCallId": "old-tool",
                "content": "done",
            },
            {"id": "new-user", "role": "user", "content": "new request"},
        ],
        tools=[],
        context=[],
        forwarded_props={},
    )
    try:
        events = [event async for event in agent.run(request)]
        event_types = [event.type for event in events]
        terminal = EventType.RUN_ERROR if fail else EventType.RUN_FINISHED
        assert event_types.count(EventType.RUN_STARTED) == 1, event_types
        assert [
            i
            for i, t in enumerate(event_types)
            if t
            in (
                EventType.RUN_ERROR,
                EventType.RUN_FINISHED,
            )
        ] == [len(events) - 1], event_types
        assert events[-1].type == terminal
        if fail:
            assert model.calls == 1
            assert "synthetic provider failure" in events[-1].message
        else:
            assert model.calls == 2
            assert events[-1].run_id == request.run_id
    finally:
        SessionManager.reset_instance()
