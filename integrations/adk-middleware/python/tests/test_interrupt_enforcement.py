"""With ``emit_interrupt_outcome=True`` the server enforces the interrupt
contract (docs/concepts/interrupts.mdx, rules 3 and 4):

* while a thread has open interrupts, a run whose ``resume`` does not address
  them is rejected with ``INTERRUPT_RESUME_REQUIRED``;
* a ``resume`` that leaves some open interrupt unanswered is rejected with
  ``INTERRUPT_RESUME_INCOMPLETE``.

A rejection changes nothing, so a conforming retry still works. Open interrupts
are read from session state, so every instance sharing the store enforces
them. Ordinary frontend tool calls are not interrupts and never block. With the
flag off nothing is enforced.
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
from ag_ui_adk import ADKAgent, AGUIToolset, PredictStateMapping
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
    content_text,
    run_finished,
    run_input,
)

USER = UserMessage(id="u-1", role="user", content="Run the dangerous action")
FOLLOW_UP = UserMessage(id="u-2", role="user", content="Actually, never mind")


@pytest.fixture(autouse=True)
def reset_session_manager():
    SessionManager.reset_instance()
    yield
    SessionManager.reset_instance()


def _rc_calls(events):
    """(tool_call_id, args) of every adk_request_confirmation call, in order."""
    calls, current = [], None
    for event in events:
        if event.type == EventType.TOOL_CALL_START and event.tool_call_name == RC_TOOL_NAME:
            current = [event.tool_call_id, ""]
            calls.append(current)
        elif event.type == EventType.TOOL_CALL_ARGS and current and event.tool_call_id == current[0]:
            current[1] += event.delta
        elif event.type == EventType.TOOL_CALL_END:
            current = None
    return [tuple(c) for c in calls]


def _history(calls):
    return [
        USER,
        AssistantMessage(
            id="a-1",
            role="assistant",
            content=None,
            tool_calls=[
                ToolCall(id=call_id, function=FunctionCall(name=RC_TOOL_NAME, arguments=args))
                for call_id, args in calls
            ],
        ),
    ]


def _confirm(call_id):
    return ResumeEntry(interrupt_id=call_id, status="resolved", payload={"confirmed": True})


def _error(events):
    errors = [e for e in events if e.type == EventType.RUN_ERROR]
    assert len(errors) == 1, [e.type for e in events]
    assert not [e for e in events if e.type == EventType.RUN_FINISHED]
    return errors[0]


def _assert_ok(events):
    assert not [e for e in events if e.type == EventType.RUN_ERROR], [
        (e.type, getattr(e, "message", None)) for e in events
    ]
    run_finished(events)


async def _pause(thread, *, targets=("foo",), emit=True, store=None):
    tool = ConfirmationTool()
    agent, llm = build_confirmation_agent(
        tool, targets=targets, emit_interrupt_outcome=emit, session_service=store
    )
    turn1 = await collect(agent, run_input(thread, "run-1", [USER]))
    calls = _rc_calls(turn1)
    assert len(calls) == len(targets)
    outcome = run_finished(turn1).outcome
    assert (outcome is not None) is emit
    return agent, llm, tool, calls


class TestResumeRequired:
    @pytest.mark.asyncio
    async def test_new_message_on_interrupted_thread_is_rejected(self):
        agent, llm, tool, calls = await _pause("t-enforce-new")
        turns = llm.turn_count

        rejected = await collect(agent, run_input("t-enforce-new", "run-2", _history(calls) + [FOLLOW_UP]))

        error = _error(rejected)
        assert error.code == "INTERRUPT_RESUME_REQUIRED"
        assert calls[0][0] in error.message
        assert llm.turn_count == turns
        assert tool.executed == 0

        # Nothing was consumed: a conforming resume still works.
        resumed = await collect(
            agent, run_input("t-enforce-new", "run-3", _history(calls), resume=[_confirm(calls[0][0])])
        )
        _assert_ok(resumed)
        assert tool.executed == 1

    @pytest.mark.asyncio
    async def test_tool_message_answer_is_rejected(self):
        """Rule 4 applies to a legacy role:"tool" answer too."""
        agent, _, tool, calls = await _pause("t-enforce-legacy")

        rejected = await collect(
            agent,
            run_input(
                "t-enforce-legacy",
                "run-2",
                _history(calls)
                + [ToolMessage(id="t-1", role="tool", tool_call_id=calls[0][0], content=json.dumps({"confirmed": True}))],
            ),
        )

        assert _error(rejected).code == "INTERRUPT_RESUME_REQUIRED"
        assert tool.executed == 0

    @pytest.mark.asyncio
    async def test_second_instance_enforces(self):
        store = InMemorySessionService()
        _, _, _, calls = await _pause("t-enforce-pod", store=store)

        other_tool = ConfirmationTool()
        other, other_llm = build_confirmation_agent(
            other_tool, emit_interrupt_outcome=True, session_service=store
        )
        rejected = await collect(other, run_input("t-enforce-pod", "run-2", _history(calls) + [FOLLOW_UP]))

        assert _error(rejected).code == "INTERRUPT_RESUME_REQUIRED"
        assert other_llm.turn_count == 0

        resumed = await collect(
            other, run_input("t-enforce-pod", "run-3", _history(calls), resume=[_confirm(calls[0][0])])
        )
        _assert_ok(resumed)
        assert other_tool.executed == 1

    @pytest.mark.asyncio
    async def test_flag_off_does_not_enforce(self):
        agent, llm, tool, calls = await _pause("t-enforce-off", emit=False)
        turns = llm.turn_count

        events = await collect(agent, run_input("t-enforce-off", "run-2", _history(calls) + [FOLLOW_UP]))

        assert not [
            e for e in events
            if e.type == EventType.RUN_ERROR and (e.code or "").startswith("INTERRUPT_")
        ]
        assert llm.turn_count > turns


class TestResumeCoverage:
    @pytest.mark.asyncio
    async def test_partial_resume_is_rejected(self):
        agent, llm, tool, calls = await _pause("t-enforce-partial", targets=("foo", "bar"))
        turns = llm.turn_count

        rejected = await collect(
            agent, run_input("t-enforce-partial", "run-2", _history(calls), resume=[_confirm(calls[0][0])])
        )

        error = _error(rejected)
        assert error.code == "INTERRUPT_RESUME_INCOMPLETE"
        assert calls[1][0] in error.message
        assert calls[0][0] not in error.message
        assert llm.turn_count == turns
        assert tool.executed == 0

    @pytest.mark.asyncio
    async def test_full_resume_proceeds(self):
        agent, _, tool, calls = await _pause("t-enforce-full", targets=("foo", "bar"))

        resumed = await collect(
            agent,
            run_input(
                "t-enforce-full",
                "run-2",
                _history(calls),
                resume=[_confirm(calls[0][0]), _confirm(calls[1][0])],
            ),
        )

        _assert_ok(resumed)
        assert tool.executed == 2


class TestWhatCountsAsAnInterrupt:
    @pytest.mark.asyncio
    async def test_pending_frontend_tool_does_not_block(self):
        llm = ScriptedLlm(model="scripted", first_call={"name": "pick_color", "args": {}})
        agent = ADKAgent.from_app(
            App(
                name="frontend_enforce_app",
                root_agent=LlmAgent(name="frontend_agent", model=llm, tools=[AGUIToolset()]),
                resumability_config=ResumabilityConfig(is_resumable=True),
            ),
            user_id="test_user",
            session_service=InMemorySessionService(),
            emit_interrupt_outcome=True,
        )
        tools = [AGUITool(name="pick_color", description="Pick a color", parameters={"type": "object", "properties": {}})]
        user = UserMessage(id="u-1", role="user", content="Pick a color")
        turn1 = await collect(agent, run_input("t-enforce-frontend", "run-1", [user], tools=tools))
        assert run_finished(turn1).outcome is None
        assert await agent._get_pending_tool_call_ids("t-enforce-frontend", "test_user")

        events = await collect(
            agent, run_input("t-enforce-frontend", "run-2", [user, FOLLOW_UP], tools=tools)
        )

        assert not [
            e for e in events
            if e.type == EventType.RUN_ERROR and (e.code or "").startswith("INTERRUPT_")
        ]

    @pytest.mark.asyncio
    async def test_open_confirm_changes_blocks_until_resumed(self):
        def write_document_local(document: str) -> dict:
            """Write the document."""
            return {"status": "written"}

        llm = ScriptedLlm(
            model="scripted",
            first_call={"name": "write_document_local", "args": {"document": "Hi"}},
        )
        agent = ADKAgent(
            adk_agent=LlmAgent(name="doc_agent", model=llm, tools=[write_document_local]),
            app_name="doc_app",
            user_id="test_user",
            session_service=InMemorySessionService(),
            emit_interrupt_outcome=True,
            predict_state=[
                PredictStateMapping(state_key="document", tool="write_document_local", tool_argument="document")
            ],
        )
        user = UserMessage(id="u-1", role="user", content="Write it")
        turn1 = await collect(agent, run_input("t-enforce-doc", "run-1", [user]))
        interrupts = run_finished(turn1).outcome.interrupts
        assert [i.reason for i in interrupts] == ["confirm_changes"]
        confirm_id = interrupts[0].id
        turns = llm.turn_count

        rejected = await collect(agent, run_input("t-enforce-doc", "run-2", [user, FOLLOW_UP]))
        assert _error(rejected).code == "INTERRUPT_RESUME_REQUIRED"
        assert llm.turn_count == turns

        resumed = await collect(
            agent,
            run_input(
                "t-enforce-doc",
                "run-3",
                [user],
                resume=[ResumeEntry(interrupt_id=confirm_id, status="resolved", payload={"accepted": False})],
            ),
        )
        _assert_ok(resumed)
        assert llm.turn_count == turns + 1
        assert "user rejected the proposed changes" in content_text(llm.last_contents[-1]).lower()
