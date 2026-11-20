"""Open synthetic decisions survive a later native tool continuation."""

from typing import AsyncGenerator

import pytest
from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    Tool,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from google.adk.agents import LlmAgent
from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import InMemorySessionService
from google.genai import types

from ag_ui_adk import ADKAgent, AGUIToolset, PredictStateMapping
from ag_ui_adk.session_manager import SessionManager
from ag_ui_adk.session_manager import PENDING_CONFIRM_CHANGES_STATE_KEY
from tests.hitl_helpers import (
    ScriptedLlm,
    collect,
    content_text,
    run_finished,
    run_input,
    tool_call,
)

APP = "mixed_approval"
USER = "test_user"
THREAD = "mixed_approval_thread"
REJECTION = "user rejected the proposed changes"


class MixedApprovalLlm(ScriptedLlm):
    """Normal user turns propose a document or request frontend scheduling."""

    async def generate_content_async(
        self, llm_request, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        self.turn_count += 1
        latest = llm_request.contents[-1]
        self.last_contents.append(latest)
        text = content_text(latest)
        if text.startswith("Draft"):
            part = types.Part(
                function_call=types.FunctionCall(
                    name="write_document", args={"document": text}
                )
            )
        elif text == "Schedule a meeting":
            part = types.Part(
                function_call=types.FunctionCall(name="scheduleTime", args={})
            )
        else:
            part = types.Part(text="Done.")
        yield LlmResponse(
            content=types.Content(role="model", parts=[part]),
            partial=False,
            turn_complete=True,
        )


def make_agent(service, model):
    def write_document(document: str) -> dict:
        """Write a document."""
        return {"written": document}

    return ADKAgent(
        adk_agent=LlmAgent(
            name="mixed_agent",
            model=model,
            tools=[write_document, AGUIToolset()],
        ),
        app_name=APP,
        user_id=USER,
        session_service=service,
        use_thread_id_as_session_id=True,
        predict_state=[
            PredictStateMapping(
                state_key="document",
                tool="write_document",
                tool_argument="document",
            )
        ],
    )


async def run(agent, messages, run_id):
    events = await collect(
        agent,
        run_input(
            THREAD,
            run_id,
            messages,
            tools=[
                Tool(
                    name="scheduleTime",
                    description="Schedule a meeting",
                    parameters={"type": "object", "properties": {}},
                )
            ],
        ),
    )
    assert not [event for event in events if event.type == EventType.RUN_ERROR]
    run_finished(events)
    return events


def append_calls(history, events, message_id, *names):
    calls = []
    for name in names:
        call_id, args = tool_call(events, name)
        assert call_id
        calls.append(
            ToolCall(
                id=call_id, function=FunctionCall(name=name, arguments=args)
            )
        )
    history.append(AssistantMessage(id=message_id, tool_calls=calls))
    return [call.id for call in calls]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cold", [False, True], ids=["same_instance", "cold_instance"]
)
async def test_mixed_rejection_is_consumed_once_without_replaying_history(
    cold,
):
    SessionManager.reset_instance()
    service = InMemorySessionService()
    model = MixedApprovalLlm(model="deterministic")
    agent = make_agent(service, model)
    try:
        # An earlier consumed confirmation must not become the boundary again.
        history = [
            UserMessage(id="first-draft", content="Draft first version")
        ]
        events = await run(agent, history, "first-draft")
        _, old_confirm = append_calls(
            history, events, "first-calls", "write_document", "confirm_changes"
        )
        history.append(
            ToolMessage(
                id="old-decision",
                tool_call_id=old_confirm,
                content='{"accepted":true}',
            )
        )
        await run(agent, history, "accept-first")

        history.append(UserMessage(id="revision", content="Draft revision"))
        events = await run(agent, history, "revision")
        _, open_confirm = append_calls(
            history,
            events,
            "revision-calls",
            "write_document",
            "confirm_changes",
        )
        history.append(
            UserMessage(id="schedule", content="Schedule a meeting")
        )
        events = await run(agent, history, "schedule")
        (pending_call,) = append_calls(
            history, events, "schedule-call", "scheduleTime"
        )
        session = await service.get_session(
            app_name=APP, user_id=USER, session_id=THREAD
        )
        assert session.state[PENDING_CONFIRM_CHANGES_STATE_KEY] == [
            open_confirm
        ]
        assert session.state["pending_tool_calls"] == [pending_call]

        if cold:
            SessionManager.reset_instance()
            agent = make_agent(service, model)
        before = model.turn_count
        history.extend(
            [
                ToolMessage(
                    id="reject-revision",
                    tool_call_id=open_confirm,
                    content='{"accepted":false}',
                ),
                ToolMessage(
                    id="schedule-result",
                    tool_call_id=pending_call,
                    content='{"scheduled":true}',
                ),
            ]
        )
        await run(agent, history, "mixed-answer")
        assert model.turn_count == before + 1
        assert REJECTION in content_text(model.last_contents[-1]).lower()

        session = await service.get_session(
            app_name=APP, user_id=USER, session_id=THREAD
        )
        assert not session.state[PENDING_CONFIRM_CHANGES_STATE_KEY]
        assert not session.state["pending_tool_calls"]
        user_texts = [
            content_text(event.content)
            for event in session.events
            if event.content and event.content.role == "user"
        ]
        assert user_texts.count("Draft first version") == 1
        assert user_texts.count("Draft revision") == 1
        assert user_texts.count("Schedule a meeting") == 1

        await run(agent, history, "replay-answer")
        assert model.turn_count == before + 1
        assert (
            sum(
                REJECTION in content_text(content).lower()
                for content in model.last_contents
            )
            == 1
        )
    finally:
        SessionManager.reset_instance()
