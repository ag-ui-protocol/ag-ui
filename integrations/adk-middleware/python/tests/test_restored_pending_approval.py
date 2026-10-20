"""Imported native history resumes its pending call.

The original prompt must not be replayed.
"""

from typing import AsyncGenerator

import pytest
from ag_ui.core import EventType, RunAgentInput, Tool, ToolMessage
from google.adk.agents import LlmAgent
from google.adk.events import Event
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import DatabaseSessionService
from google.genai import types

from ag_ui_adk import ADKAgent, AGUIToolset, adk_events_to_messages
from ag_ui_adk.session_manager import SessionManager

APP = "restored_approval"
USER = "test_user"
THREAD = "native_import"
PENDING = "original_schedule_call"
PROMPT = "Schedule a meeting."


class ApprovalLlm(BaseLlm):
    """Expose an erroneous replay as a new native call, like the provider."""

    requests: int = 0

    async def generate_content_async(
        self, llm_request, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        self.requests += 1
        latest = llm_request.contents[-1]
        if any(part.function_response for part in latest.parts):
            part = types.Part(text="Meeting scheduled.")
        else:
            part = types.Part(
                function_call=types.FunctionCall(
                    id="unexpected_second_call", name="scheduleTime", args={}
                )
            )
        yield LlmResponse(
            content=types.Content(role="model", parts=[part]),
            partial=False,
            turn_complete=True,
        )


def make_agent(service, model):
    return ADKAgent(
        adk_agent=LlmAgent(
            name="scheduler", model=model, tools=[AGUIToolset()]
        ),
        app_name=APP,
        user_id=USER,
        session_service=service,
        use_thread_id_as_session_id=True,
    )


async def seed_native_session(service):
    session = await service.create_session(
        app_name=APP,
        user_id=USER,
        session_id=THREAD,
        state={"pending_tool_calls": [PENDING]},
    )
    # Earlier completed history is essential: jumping to its result loses the
    # cursor and dispatches the later scheduling prompt a second time.
    contents = [
        ("user", types.Part(text="Look up availability.")),
        (
            "scheduler",
            types.Part(
                function_call=types.FunctionCall(
                    id="completed_lookup", name="lookup", args={}
                )
            ),
        ),
        (
            "scheduler",
            types.Part(
                function_response=types.FunctionResponse(
                    id="completed_lookup",
                    name="lookup",
                    response={"available": True},
                )
            ),
        ),
        ("scheduler", types.Part(text="Tomorrow is available.")),
        ("user", types.Part(text=PROMPT)),
        (
            "scheduler",
            types.Part(
                function_call=types.FunctionCall(
                    id=PENDING, name="scheduleTime", args={}
                )
            ),
        ),
    ]
    for index, (author, part) in enumerate(contents):
        await service.append_event(
            session=session,
            event=Event(
                id=f"native_{index}",
                invocation_id="native_invocation",
                author=author,
                content=types.Content(
                    role="user" if author == "user" else "model", parts=[part]
                ),
                long_running_tool_ids={PENDING} if index == 5 else None,
            ),
        )


async def read_session(service):
    return await service.get_session(
        app_name=APP, user_id=USER, session_id=THREAD
    )


async def run_approval(agent, messages):
    events = [
        event
        async for event in agent.run(
            RunAgentInput(
                thread_id=THREAD,
                run_id="approval_run",
                messages=messages,
                tools=[
                    Tool(
                        name="scheduleTime",
                        description="Choose a time",
                        parameters={"type": "object", "properties": {}},
                    )
                ],
                context=[],
                state={},
                forwarded_props={},
            )
        )
    ]
    assert not [event for event in events if event.type == EventType.RUN_ERROR]
    return events


@pytest.mark.asyncio
async def test_imported_approval_resumes_once_and_survives_reload_and_restart(
    tmp_path,
):
    SessionManager.reset_instance()
    db_url = f"sqlite+aiosqlite:///{tmp_path / 'native.db'}"
    service = DatabaseSessionService(db_url=db_url)
    try:
        await seed_native_session(service)
        await service.close()
        service = DatabaseSessionService(db_url=db_url)
        model = ApprovalLlm(model="deterministic")
        agent = make_agent(service, model)
        messages = adk_events_to_messages((await read_session(service)).events)
        messages.append(
            ToolMessage(
                id="approval",
                tool_call_id=PENDING,
                content='{"success":true,"time":"Tomorrow 2 PM"}',
            )
        )
        events = await run_approval(agent, messages)
        assert model.requests == 1
        assert not [
            event
            for event in events
            if event.type == EventType.TOOL_CALL_START
        ]

        async def assert_settled():
            session = await read_session(service)
            parts = [
                part
                for event in session.events
                if event.content
                for part in event.content.parts
            ]
            assert [part.text for part in parts].count(PROMPT) == 1
            assert [
                part.function_call.id for part in parts if part.function_call
            ] == [
                "completed_lookup",
                PENDING,
            ]
            results = [
                part.function_response
                for part in parts
                if part.function_response
                and part.function_response.id == PENDING
            ]
            assert len(results) == 1
            assert results[0].response == {
                "success": True,
                "time": "Tomorrow 2 PM",
            }
            assert not session.state.get("pending_tool_calls")
            return session

        session = await assert_settled()
        replay = adk_events_to_messages(session.events)
        await run_approval(agent, replay)
        assert model.requests == 1
        await assert_settled()

        await service.close()
        SessionManager.reset_instance()
        service = DatabaseSessionService(db_url=db_url)
        restarted_model = ApprovalLlm(model="deterministic")
        await run_approval(make_agent(service, restarted_model), replay)
        assert restarted_model.requests == 0
        await assert_settled()
    finally:
        await service.close()
        SessionManager.reset_instance()
