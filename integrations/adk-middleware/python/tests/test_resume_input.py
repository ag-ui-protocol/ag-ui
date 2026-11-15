"""``RunAgentInput.resume[]`` resumes a paused run without a role:"tool" message.

Each resume entry is mapped onto the same tool-result round trip a ToolMessage
takes, so an ADK tool confirmation re-executes the gated tool exactly as it does
when the client answers with a ToolMessage.
"""

import json

import pytest

from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    ResumeEntry,
    Tool as AGUITool,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from ag_ui_adk import ADKAgent, AGUIToolset
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents.llm_agent import LlmAgent
from google.adk.apps import App, ResumabilityConfig
from google.adk.sessions import InMemorySessionService

from tests.hitl_helpers import (
    RC_TOOL_NAME,
    ConfirmationTool,
    ScriptedLlm,
    build_confirmation_agent,
    collect,
    run_finished,
    run_input,
    tool_call,
)

USER = UserMessage(id="u-1", role="user", content="Run the dangerous action with target='foo'")


@pytest.fixture(params=[False, True], ids=["outcome_off", "outcome_on"])
def emit_outcome(request):
    """resume[] is accepted whether or not RUN_FINISHED reports the interrupt."""
    return request.param


@pytest.fixture(autouse=True)
def reset_session_manager():
    SessionManager.reset_instance()
    yield
    SessionManager.reset_instance()


async def _pause(thread_id: str, emit_outcome: bool):
    tool = ConfirmationTool()
    agent, llm = build_confirmation_agent(tool, emit_interrupt_outcome=emit_outcome)
    turn1 = await collect(agent, run_input(thread_id, "run-1", [USER]))
    rc_id, rc_args = tool_call(turn1, RC_TOOL_NAME)
    assert rc_id
    assert (run_finished(turn1).outcome is not None) is emit_outcome
    assert tool.executed == 0
    history = [
        USER,
        AssistantMessage(
            id="a-1",
            role="assistant",
            content=None,
            tool_calls=[
                ToolCall(
                    id=rc_id,
                    function=FunctionCall(name=RC_TOOL_NAME, arguments=rc_args or "{}"),
                )
            ],
        ),
    ]
    return agent, llm, tool, rc_id, history


def _errors(events):
    return [e for e in events if e.type == EventType.RUN_ERROR]


class TestResumeConfirmation:
    @pytest.mark.asyncio
    async def test_resolved_resume_reexecutes_tool_exactly_once(self, emit_outcome):
        agent, _, tool, rc_id, history = await _pause("t-resume-ok", emit_outcome)

        turn2 = await collect(
            agent,
            run_input(
                "t-resume-ok",
                "run-2",
                history,
                resume=[ResumeEntry(interrupt_id=rc_id, status="resolved", payload={"confirmed": True})],
            ),
        )

        assert not _errors(turn2)
        assert tool.executed == 1
        assert [c.confirmed for c in tool.confirmations] == [True]
        assert run_finished(turn2).outcome is None

    @pytest.mark.asyncio
    async def test_cancelled_resume_does_not_execute_tool(self, emit_outcome):
        agent, _, tool, rc_id, history = await _pause("t-resume-cancel", emit_outcome)

        turn2 = await collect(
            agent,
            run_input(
                "t-resume-cancel",
                "run-2",
                history,
                resume=[ResumeEntry(interrupt_id=rc_id, status="cancelled")],
            ),
        )

        assert not _errors(turn2)
        assert tool.executed == 0
        assert [c.confirmed for c in tool.confirmations] == [False]
        run_finished(turn2)

    @pytest.mark.asyncio
    async def test_resolved_payload_without_confirmed_key_becomes_tool_confirmation_payload(self, emit_outcome):
        agent, _, tool, rc_id, history = await _pause("t-resume-payload", emit_outcome)
        chosen = {"chosen_time": "2026-10-01T10:00:00Z"}

        turn2 = await collect(
            agent,
            run_input(
                "t-resume-payload",
                "run-2",
                history,
                resume=[ResumeEntry(interrupt_id=rc_id, status="resolved", payload=chosen)],
            ),
        )

        assert not _errors(turn2)
        assert tool.executed == 1
        assert len(tool.confirmations) == 1
        assert tool.confirmations[0].confirmed is True
        assert tool.confirmations[0].payload == chosen

    @pytest.mark.asyncio
    @pytest.mark.parametrize("payload", [False, {"approved": False}, {"confirmed": False}])
    async def test_resolved_denial_does_not_execute_tool(self, payload, emit_outcome):
        agent, _, tool, rc_id, history = await _pause("t-resume-deny", emit_outcome)

        turn2 = await collect(
            agent,
            run_input(
                "t-resume-deny",
                "run-2",
                history,
                resume=[ResumeEntry(interrupt_id=rc_id, status="resolved", payload=payload)],
            ),
        )

        assert not _errors(turn2)
        assert tool.executed == 0
        assert [c.confirmed for c in tool.confirmations] == [False]

    @pytest.mark.asyncio
    async def test_resume_without_assistant_history_resolves_pending_call(self, emit_outcome):
        """A client that sends only the resume (no replayed history) still resumes."""
        agent, _, tool, rc_id, _ = await _pause("t-resume-bare", emit_outcome)

        turn2 = await collect(
            agent,
            run_input(
                "t-resume-bare",
                "run-2",
                [USER],
                resume=[ResumeEntry(interrupt_id=rc_id, status="resolved", payload={"confirmed": True})],
            ),
        )

        assert not _errors(turn2)
        assert tool.executed == 1

    @pytest.mark.asyncio
    async def test_resume_and_tool_message_for_same_call_submit_once(self, emit_outcome):
        agent, _, tool, rc_id, history = await _pause("t-resume-dup", emit_outcome)

        turn2 = await collect(
            agent,
            run_input(
                "t-resume-dup",
                "run-2",
                history
                + [
                    ToolMessage(
                        id="t-1",
                        role="tool",
                        tool_call_id=rc_id,
                        content=json.dumps({"confirmed": False}),
                    )
                ],
                resume=[ResumeEntry(interrupt_id=rc_id, status="resolved", payload={"confirmed": True})],
            ),
        )

        assert not _errors(turn2)
        # The resume entry wins and the tool sees a single confirmation.
        assert [c.confirmed for c in tool.confirmations] == [True]
        assert tool.executed == 1

    @pytest.mark.asyncio
    async def test_replayed_resume_does_not_reexecute(self, emit_outcome):
        agent, _, tool, rc_id, history = await _pause("t-resume-replay", emit_outcome)
        resume = [ResumeEntry(interrupt_id=rc_id, status="resolved", payload={"confirmed": True})]

        await collect(agent, run_input("t-resume-replay", "run-2", history, resume=resume))
        replay = await collect(agent, run_input("t-resume-replay", "run-3", history, resume=resume))

        assert not _errors(replay)
        run_finished(replay)
        assert tool.executed == 1

    @pytest.mark.asyncio
    async def test_unknown_interrupt_id_emits_run_error(self, emit_outcome):
        agent, _, tool, _, history = await _pause("t-resume-unknown", emit_outcome)

        turn2 = await collect(
            agent,
            run_input(
                "t-resume-unknown",
                "run-2",
                history,
                resume=[ResumeEntry(interrupt_id="does-not-exist", status="resolved", payload={})],
            ),
        )

        errors = _errors(turn2)
        assert len(errors) == 1
        assert "does-not-exist" in errors[0].message
        assert not [e for e in turn2 if e.type == EventType.RUN_FINISHED]
        assert tool.executed == 0


class TestResumeFrontendTool:
    @pytest.mark.asyncio
    async def test_resume_resolves_pending_frontend_tool_call(self, emit_outcome):
        llm = ScriptedLlm(model="scripted", first_call={"name": "pick_color", "args": {}})
        agent = ADKAgent.from_app(
            App(
                name="frontend_resume_app",
                root_agent=LlmAgent(name="frontend_agent", model=llm, tools=[AGUIToolset()]),
                resumability_config=ResumabilityConfig(is_resumable=True),
            ),
            user_id="test_user",
            session_service=InMemorySessionService(),
            emit_interrupt_outcome=emit_outcome,
        )
        tools = [
            AGUITool(
                name="pick_color",
                description="Ask the user to pick a color",
                parameters={"type": "object", "properties": {}},
            )
        ]
        user = UserMessage(id="u-1", role="user", content="Pick a color")
        turn1 = await collect(agent, run_input("t-frontend-resume", "run-1", [user], tools=tools))
        call_id, _ = tool_call(turn1, "pick_color")
        assert call_id

        history = [
            user,
            AssistantMessage(
                id="a-1",
                role="assistant",
                content=None,
                tool_calls=[ToolCall(id=call_id, function=FunctionCall(name="pick_color", arguments="{}"))],
            ),
        ]
        turn2 = await collect(
            agent,
            run_input(
                "t-frontend-resume",
                "run-2",
                history,
                tools=tools,
                resume=[ResumeEntry(interrupt_id=call_id, status="resolved", payload={"color": "blue"})],
            ),
        )

        assert not _errors(turn2)
        run_finished(turn2)
        # The model was resumed with the payload as the tool's result.
        assert llm.turn_count == 2
        responses = [
            p.function_response
            for p in (llm.last_contents[-1].parts or [])
            if p.function_response is not None
        ]
        assert [r.name for r in responses] == ["pick_color"]
        assert responses[0].response == {"color": "blue"}


class TestResumeEntryContent:
    """How a resume entry is rendered for tools that are not confirmations."""

    def test_cancelled_frontend_tool_gets_cancelled_result(self):
        content = ADKAgent._resume_entry_content(
            "pick_color", ResumeEntry(interrupt_id="c1", status="cancelled")
        )
        assert json.loads(content) == {"status": "cancelled", "cancelled": True}

    def test_resolved_frontend_tool_passes_payload_through(self):
        assert ADKAgent._resume_entry_content(
            "pick_color", ResumeEntry(interrupt_id="c1", status="resolved", payload="blue")
        ) == "blue"
        assert json.loads(
            ADKAgent._resume_entry_content(
                "pick_color",
                ResumeEntry(interrupt_id="c1", status="resolved", payload={"color": "blue"}),
            )
        ) == {"color": "blue"}
