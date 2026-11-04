"""With ``emit_interrupt_outcome=True``, RUN_FINISHED carries a structured
interrupt outcome when a run pauses on a human decision: ADK tool confirmation
(``adk_request_confirmation``) or the predictive-state ``confirm_changes``
review. Ordinary runs and ordinary frontend tool calls keep a plain
RUN_FINISHED. The flag defaults off, and then no run carries an outcome.
"""

import pytest

from ag_ui.core import RunFinishedInterruptOutcome, Tool as AGUITool, UserMessage
from ag_ui_adk import ADKAgent, AGUIToolset, PredictStateMapping
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents.llm_agent import LlmAgent
from google.adk.apps import App, ResumabilityConfig
from google.adk.sessions import InMemorySessionService

from tests.hitl_helpers import (
    RC_TOOL_NAME,
    ConfirmationTool,
    ScriptedLlm,
    args_json,
    build_confirmation_agent,
    collect,
    run_finished,
    run_input,
    tool_call,
)


@pytest.fixture(autouse=True)
def reset_session_manager():
    SessionManager.reset_instance()
    yield
    SessionManager.reset_instance()


def _user(text: str = "Run the dangerous action with target='foo'"):
    return UserMessage(id="u-1", role="user", content=text)


class TestConfirmationInterruptOutcome:
    @pytest.mark.asyncio
    async def test_confirmation_pause_ends_with_interrupt_outcome(self):
        tool = ConfirmationTool()
        agent, _ = build_confirmation_agent(tool, emit_interrupt_outcome=True)

        events = await collect(agent, run_input("t-rc", "run-1", [_user()]))

        rc_id, rc_args = tool_call(events, RC_TOOL_NAME)
        assert rc_id, "turn 1 must emit the adk_request_confirmation tool call"
        assert tool.executed == 0

        finished = run_finished(events)
        assert isinstance(finished.outcome, RunFinishedInterruptOutcome)
        assert finished.outcome.type == "interrupt"
        assert len(finished.outcome.interrupts) == 1

        interrupt = finished.outcome.interrupts[0]
        args = args_json(rc_args)
        assert interrupt.id == rc_id
        assert interrupt.tool_call_id == rc_id
        assert interrupt.reason == "confirmation"
        assert interrupt.message == "Confirm dangerous_action on target='foo'?"
        assert interrupt.metadata == {
            "adk": {
                "originalFunctionCall": args["originalFunctionCall"],
                "toolConfirmation": args["toolConfirmation"],
            }
        }
        assert interrupt.metadata["adk"]["originalFunctionCall"]["name"] == "dangerous_action"
        assert interrupt.metadata["adk"]["originalFunctionCall"]["args"] == {"target": "foo"}

        # The wire form uses the protocol's camelCase names.
        dumped = finished.model_dump(by_alias=True, exclude_none=True)
        assert dumped["outcome"]["interrupts"][0]["toolCallId"] == rc_id

    @pytest.mark.asyncio
    async def test_plain_run_has_no_interrupt_outcome(self):
        llm = ScriptedLlm(model="scripted")
        agent = ADKAgent(
            adk_agent=LlmAgent(name="plain_agent", model=llm),
            app_name="plain_app",
            user_id="test_user",
            session_service=InMemorySessionService(),
            emit_interrupt_outcome=True,
        )

        events = await collect(agent, run_input("t-plain", "run-1", [_user("Hello")]))

        finished = run_finished(events)
        assert finished.outcome is None
        assert "outcome" not in finished.model_dump(exclude_none=True)

    @pytest.mark.asyncio
    async def test_frontend_tool_call_is_not_an_interrupt(self):
        llm = ScriptedLlm(model="scripted", first_call={"name": "pick_color", "args": {}})
        agent = ADKAgent.from_app(
            App(
                name="frontend_app",
                root_agent=LlmAgent(
                    name="frontend_agent", model=llm, tools=[AGUIToolset()]
                ),
                resumability_config=ResumabilityConfig(is_resumable=True),
            ),
            user_id="test_user",
            session_service=InMemorySessionService(),
            emit_interrupt_outcome=True,
        )
        tools = [
            AGUITool(
                name="pick_color",
                description="Ask the user to pick a color",
                parameters={"type": "object", "properties": {}},
            )
        ]

        events = await collect(
            agent, run_input("t-frontend", "run-1", [_user("Pick a color")], tools=tools)
        )

        call_id, _ = tool_call(events, "pick_color")
        assert call_id, "the frontend tool call must still be emitted"
        assert run_finished(events).outcome is None


def _doc_agent(**agent_kwargs) -> ADKAgent:
    def write_document_local(document: str) -> dict:
        """Write the document."""
        return {"status": "written"}

    llm = ScriptedLlm(
        model="scripted",
        first_call={"name": "write_document_local", "args": {"document": "Hi"}},
    )
    return ADKAgent(
        adk_agent=LlmAgent(name="doc_agent", model=llm, tools=[write_document_local]),
        app_name="doc_app",
        user_id="test_user",
        session_service=InMemorySessionService(),
        predict_state=[
            PredictStateMapping(
                state_key="document",
                tool="write_document_local",
                tool_argument="document",
            )
        ],
        **agent_kwargs,
    )


class TestConfirmChangesInterruptOutcome:
    @pytest.mark.asyncio
    async def test_confirm_changes_run_ends_with_interrupt_outcome(self):
        agent = _doc_agent(emit_interrupt_outcome=True)

        events = await collect(agent, run_input("t-doc", "run-1", [_user("Write it")]))

        # The confirm_changes trio is still emitted for existing frontends.
        confirm_id, confirm_args = tool_call(events, "confirm_changes")
        assert confirm_id
        assert confirm_args == "{}"

        finished = run_finished(events)
        assert isinstance(finished.outcome, RunFinishedInterruptOutcome)
        assert len(finished.outcome.interrupts) == 1
        interrupt = finished.outcome.interrupts[0]
        assert interrupt.id == confirm_id
        assert interrupt.tool_call_id == confirm_id
        assert interrupt.reason == "confirm_changes"
        assert interrupt.metadata == {
            "predict_state": [
                {
                    "state_key": "document",
                    "tool": "write_document_local",
                    "tool_argument": "document",
                }
            ]
        }


class TestInterruptOutcomeDefaultOff:
    """Frontends that answer with a plain tool message (CopilotKit
    ``useHumanInTheLoop``, the predictive-state confirm dialog) are rejected by
    ``@ag-ui/client`` once a RUN_FINISHED carried interrupts, so by default no
    RUN_FINISHED carries an outcome."""

    @pytest.mark.asyncio
    async def test_confirmation_pause_has_no_outcome_by_default(self):
        tool = ConfirmationTool()
        agent, _ = build_confirmation_agent(tool)

        events = await collect(agent, run_input("t-rc-off", "run-1", [_user()]))

        rc_id, _ = tool_call(events, RC_TOOL_NAME)
        assert rc_id, "the adk_request_confirmation tool call is still emitted"
        finished = run_finished(events)
        assert finished.outcome is None
        assert "outcome" not in finished.model_dump(exclude_none=True)

    @pytest.mark.asyncio
    async def test_confirm_changes_run_has_no_outcome_by_default(self):
        agent = _doc_agent()

        events = await collect(agent, run_input("t-doc-off", "run-1", [_user("Write it")]))

        confirm_id, _ = tool_call(events, "confirm_changes")
        assert confirm_id, "the confirm_changes trio is still emitted"
        finished = run_finished(events)
        assert finished.outcome is None
        assert "outcome" not in finished.model_dump(exclude_none=True)

    def test_flag_defaults_off(self):
        import inspect

        for ctor in (ADKAgent.__init__, ADKAgent.from_app):
            param = inspect.signature(ctor).parameters["emit_interrupt_outcome"]
            assert param.default is False


class TestConfirmationInterruptShape:
    """``confirmation_interrupt`` tolerates missing or malformed ADK args."""

    @staticmethod
    def _call(args):
        from google.genai import types

        return types.FunctionCall(id="rc-1", name=RC_TOOL_NAME, args=args)

    def test_full_args(self):
        from ag_ui_adk.event_translator import confirmation_interrupt

        original = {"id": "fc-1", "name": "dangerous_action", "args": {"target": "foo"}}
        confirmation = {"hint": "Sure?", "confirmed": False, "payload": {"x": 1}}
        interrupt = confirmation_interrupt(
            self._call({"originalFunctionCall": original, "toolConfirmation": confirmation})
        )
        assert interrupt.model_dump(exclude_none=True) == {
            "id": "rc-1",
            "reason": "confirmation",
            "tool_call_id": "rc-1",
            "message": "Sure?",
            "metadata": {"adk": {"originalFunctionCall": original, "toolConfirmation": confirmation}},
        }

    @pytest.mark.parametrize(
        "args",
        [None, {}, {"toolConfirmation": {"hint": ""}}, {"toolConfirmation": "not-a-dict"}],
    )
    def test_missing_or_empty_hint_gives_no_message(self, args):
        from ag_ui_adk.event_translator import confirmation_interrupt

        interrupt = confirmation_interrupt(self._call(args))
        assert interrupt.id == interrupt.tool_call_id == "rc-1"
        assert interrupt.reason == "confirmation"
        assert interrupt.message is None
        assert set(interrupt.metadata["adk"]) == {"originalFunctionCall", "toolConfirmation"}
