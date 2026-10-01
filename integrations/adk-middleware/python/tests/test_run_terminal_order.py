"""One requested run must have one terminal, even when history spans batches."""

import pytest

from ag_ui.core import EventType, RunAgentInput, RunErrorEvent
from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import DatabaseSessionService, InMemorySessionService
from google.genai import types


class FixedModel(BaseLlm):
    """Exercise the real ADK runner without network or tool-data dependencies."""

    model: str = "terminal-order-test"
    fail: bool = False
    fail_on_call: int = 0
    calls: int = 0

    async def generate_content_async(self, llm_request, stream=False):
        self.calls += 1
        if self.fail or self.calls == self.fail_on_call:
            raise RuntimeError("synthetic provider failure")
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="NEW_REPLY")]),
            partial=False,
            turn_complete=True,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_on_call", [0, 1, 2])
async def test_history_batches_share_one_terminal(fail_on_call):
    """A cold message cache can dispatch several batches in one run request."""
    SessionManager.reset_instance()
    model = FixedModel(fail_on_call=fail_on_call)
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
        terminal = EventType.RUN_ERROR if fail_on_call else EventType.RUN_FINISHED
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
        if fail_on_call:
            assert model.calls == fail_on_call
            assert "synthetic provider failure" in events[-1].message
        else:
            assert model.calls == 2
            assert events[-1].run_id == request.run_id
    finally:
        SessionManager.reset_instance()


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_result", [False, True])
async def test_failed_batch_is_closed_before_run_returns(monkeypatch, tool_result):
    """Stopping after RUN_ERROR must still finish the producer's cleanup."""
    SessionManager.reset_instance()
    agent = ADKAgent(
        adk_agent=LlmAgent(name="test", model=FixedModel()),
        app_name="test",
        user_id="user",
        session_service=InMemorySessionService(),
    )
    closed = []

    async def failed_batch(*args, **kwargs):
        try:
            yield RunErrorEvent(message="failure")
        finally:
            closed.append(True)

    monkeypatch.setattr(
        agent,
        "_handle_tool_result_submission" if tool_result else "_start_new_execution",
        failed_batch,
    )
    request = RunAgentInput(
        thread_id="cleanup",
        run_id="cleanup",
        state={},
        tools=[],
        context=[],
        forwarded_props={},
        messages=[
            (
                {
                    "id": "result",
                    "role": "tool",
                    "toolCallId": "tool",
                    "content": "done",
                }
                if tool_result
                else {"id": "user", "role": "user", "content": "go"}
            )
        ],
    )
    try:
        events = [event async for event in agent.run(request)]
        assert [event.type for event in events] == [EventType.RUN_ERROR]
        assert closed == [True]
    finally:
        SessionManager.reset_instance()


@pytest.mark.asyncio
@pytest.mark.parametrize("prior_error", [False, True])
async def test_existing_sqlite_session_continues_after_cache_reset(
    tmp_path, prior_error
):
    """Separate session identity from lifecycle: use an already mapped native id."""
    SessionManager.reset_instance()
    service = DatabaseSessionService(
        db_url=f"sqlite+aiosqlite:///{tmp_path / 'adk.db'}"
    )
    session_id = "configured-native-session"
    await service.create_session(
        app_name="test",
        user_id="user",
        session_id=session_id,
        state={"_ag_ui_thread_id": session_id},
    )
    model = FixedModel()

    def middleware():
        return ADKAgent(
            adk_agent=LlmAgent(name="test", model=model),
            app_name="test",
            user_id="user",
            session_service=service,
        )

    def request(label):
        return RunAgentInput(
            thread_id=session_id,
            run_id=label,
            state={},
            context=[],
            tools=[],
            forwarded_props={},
            messages=[{"id": label, "role": "user", "content": label}],
        )

    try:
        source = middleware()
        if prior_error:
            model.fail = True
            failed = [event async for event in source.run(request("failed-source"))]
            assert failed[-1].type == EventType.RUN_ERROR
            model.fail = False
        source_events = [
            event async for event in source.run(request("successful-source"))
        ]
        assert source_events[-1].type == EventType.RUN_FINISHED
        before = await service.get_session(
            app_name="test", user_id="user", session_id=session_id
        )
        before_ids = [event.id for event in before.events]

        SessionManager.reset_instance()
        continued = [event async for event in middleware().run(request("new-reply"))]
        assert continued[0].type == EventType.RUN_STARTED
        assert continued[-1].type == EventType.RUN_FINISHED
        assert (
            sum(
                event.type in (EventType.RUN_ERROR, EventType.RUN_FINISHED)
                for event in continued
            )
            == 1
        )
        restored = await service.get_session(
            app_name="test", user_id="user", session_id=session_id
        )
        assert [event.id for event in restored.events[: len(before_ids)]] == before_ids
        assert len(restored.events) > len(before_ids)
        assert restored.events[-1].content.parts[0].text == "NEW_REPLY"
        sessions = await service.list_sessions(app_name="test", user_id="user")
        assert [session.id for session in sessions.sessions] == [session_id]
    finally:
        await service.close()
        SessionManager.reset_instance()
