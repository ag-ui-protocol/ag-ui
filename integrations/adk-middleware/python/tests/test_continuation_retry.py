"""An answer to a paused run survives a continuation that fails to start.

When the backend refuses the continuation (here: the concurrent-execution limit
is reached), nothing about the answer may be consumed: the pending call or
confirm_changes id and the answering message stay retryable. Once a retry is
accepted the answer is delivered exactly once, and a duplicate retry is a
no-op.
"""

import asyncio
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
from ag_ui_adk.execution_state import ExecutionState
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents.llm_agent import LlmAgent
from google.adk.apps import App, ResumabilityConfig
from google.adk.sessions import InMemorySessionService

from tests.hitl_helpers import (
    RC_TOOL_NAME,
    ConfirmationTool,
    ScriptedLlm,
    collect,
    content_text,
    run_finished,
    run_input,
    tool_call,
)

REJECTION = "user rejected the proposed changes"


@pytest.fixture(autouse=True)
def reset_session_manager():
    SessionManager.reset_instance()
    yield
    SessionManager.reset_instance()


class _BusySlot:
    """Occupies the agent's only execution slot with another thread's run."""

    def __init__(self, agent: ADKAgent):
        self._agent = agent
        self._task = None

    async def __aenter__(self):
        self._task = asyncio.ensure_future(asyncio.sleep(3600))
        self._agent._active_executions[("other-thread", "test_user")] = ExecutionState(
            task=self._task, thread_id="other-thread", event_queue=asyncio.Queue()
        )
        return self

    async def __aexit__(self, *exc):
        self._agent._active_executions.pop(("other-thread", "test_user"), None)
        self._task.cancel()


def _assert_capacity_error(events):
    errors = [e for e in events if e.type == EventType.RUN_ERROR]
    assert len(errors) == 1, [e.type for e in events]
    assert "Maximum concurrent executions" in errors[0].message
    assert not [e for e in events if e.type == EventType.RUN_FINISHED]


def _assert_ok(events):
    assert not [e for e in events if e.type == EventType.RUN_ERROR], [e.type for e in events]
    run_finished(events)


def _doc_agent():
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
        max_concurrent_executions=1,
        predict_state=[
            PredictStateMapping(
                state_key="document", tool="write_document_local", tool_argument="document"
            )
        ],
    )
    return agent, llm


async def _propose(agent, thread_id):
    user = UserMessage(id="u-1", role="user", content="Write it")
    events = await collect(agent, run_input(thread_id, "run-1", [user]))
    write_id, write_args = tool_call(events, "write_document_local")
    confirm_id, _ = tool_call(events, "confirm_changes")
    assert write_id and confirm_id
    history = [
        user,
        AssistantMessage(
            id="a-1",
            role="assistant",
            content=None,
            tool_calls=[
                ToolCall(id=write_id, function=FunctionCall(name="write_document_local", arguments=write_args)),
                ToolCall(id=confirm_id, function=FunctionCall(name="confirm_changes", arguments="{}")),
            ],
        ),
    ]
    return confirm_id, history


def _rejections(llm, first_turn):
    return [
        c for c in llm.last_contents[first_turn:] if REJECTION in content_text(c).lower()
    ]


class TestConfirmChangesDecisionRetry:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("via", ["tool_message", "resume"])
    async def test_capacity_failure_then_retry_delivers_once(self, via):
        agent, llm = _doc_agent()
        thread = f"t-confirm-retry-{via}"
        confirm_id, history = await _propose(agent, thread)
        turns = llm.turn_count

        if via == "tool_message":
            answer = dict(
                messages=history
                + [ToolMessage(id="t-1", role="tool", tool_call_id=confirm_id, content='{"accepted":false}')]
            )
        else:
            answer = dict(
                messages=history,
                resume=[ResumeEntry(interrupt_id=confirm_id, status="resolved", payload={"accepted": False})],
            )

        async with _BusySlot(agent):
            refused = await collect(agent, run_input(thread, "run-2", **answer))
        _assert_capacity_error(refused)
        assert llm.turn_count == turns, "a refused continuation must not reach the model"

        retry = await collect(agent, run_input(thread, "run-3", **answer))
        _assert_ok(retry)
        assert llm.turn_count == turns + 1
        assert len(_rejections(llm, turns)) == 1

        duplicate = await collect(agent, run_input(thread, "run-4", **answer))
        _assert_ok(duplicate)
        assert llm.turn_count == turns + 1
        assert len(_rejections(llm, turns)) == 1


def _confirmation_agent(tool):
    llm = ScriptedLlm(
        model="scripted",
        first_call={"name": "dangerous_action", "args": {"target": "foo"}},
    )
    agent = ADKAgent.from_app(
        App(
            name="confirmation_app",
            root_agent=LlmAgent(name="confirmation_agent", model=llm, tools=[tool.fn]),
            resumability_config=ResumabilityConfig(is_resumable=True),
        ),
        user_id="test_user",
        session_service=InMemorySessionService(),
        # The paused run itself keeps an execution slot until it is answered.
        max_concurrent_executions=2,
    )
    return agent, llm


class TestToolConfirmationRetry:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("via", ["tool_message", "resume"])
    async def test_capacity_failure_then_retry_executes_once(self, via):
        tool = ConfirmationTool()
        agent, _ = _confirmation_agent(tool)
        thread = f"t-rc-retry-{via}"
        user = UserMessage(id="u-1", role="user", content="Run it")
        turn1 = await collect(agent, run_input(thread, "run-1", [user]))
        rc_id, rc_args = tool_call(turn1, RC_TOOL_NAME)
        assert rc_id
        history = [
            user,
            AssistantMessage(
                id="a-1",
                role="assistant",
                content=None,
                tool_calls=[ToolCall(id=rc_id, function=FunctionCall(name=RC_TOOL_NAME, arguments=rc_args))],
            ),
        ]
        if via == "tool_message":
            answer = dict(
                messages=history
                + [ToolMessage(id="t-1", role="tool", tool_call_id=rc_id, content=json.dumps({"confirmed": True}))]
            )
        else:
            answer = dict(
                messages=history,
                resume=[ResumeEntry(interrupt_id=rc_id, status="resolved", payload={"confirmed": True})],
            )

        async with _BusySlot(agent):
            refused = await collect(agent, run_input(thread, "run-2", **answer))
        _assert_capacity_error(refused)
        assert tool.executed == 0

        retry = await collect(agent, run_input(thread, "run-3", **answer))
        _assert_ok(retry)
        assert tool.executed == 1

        duplicate = await collect(agent, run_input(thread, "run-4", **answer))
        _assert_ok(duplicate)
        assert tool.executed == 1


class TestFrontendToolResultRetry:
    @pytest.mark.asyncio
    async def test_capacity_failure_then_retry_resumes_model_once(self):
        llm = ScriptedLlm(model="scripted", first_call={"name": "pick_color", "args": {}})
        agent = ADKAgent.from_app(
            App(
                name="frontend_retry_app",
                root_agent=LlmAgent(name="frontend_agent", model=llm, tools=[AGUIToolset()]),
                resumability_config=ResumabilityConfig(is_resumable=True),
            ),
            user_id="test_user",
            session_service=InMemorySessionService(),
            # The paused run itself keeps an execution slot until it is answered.
            max_concurrent_executions=2,
        )
        tools = [
            AGUITool(name="pick_color", description="Pick a color", parameters={"type": "object", "properties": {}})
        ]
        thread = "t-frontend-retry"
        user = UserMessage(id="u-1", role="user", content="Pick a color")
        turn1 = await collect(agent, run_input(thread, "run-1", [user], tools=tools))
        call_id, _ = tool_call(turn1, "pick_color")
        assert call_id
        messages = [
            user,
            AssistantMessage(
                id="a-1",
                role="assistant",
                content=None,
                tool_calls=[ToolCall(id=call_id, function=FunctionCall(name="pick_color", arguments="{}"))],
            ),
            ToolMessage(id="t-1", role="tool", tool_call_id=call_id, content='{"color": "blue"}'),
        ]

        async with _BusySlot(agent):
            refused = await collect(agent, run_input(thread, "run-2", messages, tools=tools))
        _assert_capacity_error(refused)
        assert llm.turn_count == 1

        retry = await collect(agent, run_input(thread, "run-3", messages, tools=tools))
        _assert_ok(retry)
        assert llm.turn_count == 2

        duplicate = await collect(agent, run_input(thread, "run-4", messages, tools=tools))
        _assert_ok(duplicate)
        assert llm.turn_count == 2
