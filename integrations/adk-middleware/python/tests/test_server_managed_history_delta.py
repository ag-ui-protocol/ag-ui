"""Server-managed history: runs whose input is a delta upload.

Prototype for ag-ui-protocol/ag-ui#2186. A supporting client sends only
unconfirmed messages, plus the assistant message that owns each tool result in
the delta and every system/developer message. The owner message is a courtesy:
a tool result must still reach ADK under its function's name when only the
result arrives, and a ``confirm_changes`` result must still be treated as the
user's decision rather than a function response.
"""

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
from ag_ui_adk import ADKAgent, AGUIToolset, PredictStateMapping, adk_events_to_messages
from ag_ui_adk.adk_agent import PENDING_CONFIRM_CHANGES_STATE_KEY
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents import LlmAgent
from google.adk.apps import App, ResumabilityConfig
from google.adk.events import Event
from google.adk.sessions import InMemorySessionService
from google.genai import types

from tests.hitl_helpers import ScriptedLlm, collect, content_text, run_finished, tool_call
from tests.test_server_managed_history import (
    APP,
    USER,
    RecordingModel,
    _agent,
    _assistant_text_id,
    _input,
    _run,
    _user,
)

THREAD = "t-delta"
PICK_COLOR = AGUITool(
    name="pick_color",
    description="Ask the user to pick a color",
    parameters={"type": "object", "properties": {}},
)
REJECTION = "user rejected the proposed changes"


@pytest.fixture(autouse=True)
def reset_session_manager():
    SessionManager.reset_instance()
    yield
    SessionManager.reset_instance()


def _owner(call_id, name):
    return AssistantMessage(
        id=f"owner-{call_id}",
        role="assistant",
        content=None,
        tool_calls=[ToolCall(id=call_id, function=FunctionCall(name=name, arguments="{}"))],
    )


def _function_responses(content):
    return [
        part.function_response
        for part in (getattr(content, "parts", None) or [])
        if part.function_response is not None
    ]


def _errors(events):
    return [e for e in events if e.type == EventType.RUN_ERROR]


def _delta(run_id, messages, cursor, **update):
    run = _input(THREAD, run_id, messages, cursor=cursor)
    return run.model_copy(update=update) if update else run


def _frontend_agent(resumable):
    llm = ScriptedLlm(model="scripted", first_call={"name": "pick_color", "args": {}})
    root = LlmAgent(name="frontend_agent", model=llm, tools=[AGUIToolset()])
    app = App(
        name=APP,
        root_agent=root,
        **({"resumability_config": ResumabilityConfig(is_resumable=True)} if resumable else {}),
    )
    agent = ADKAgent.from_app(
        app,
        user_id=USER,
        session_service=InMemorySessionService(),
        server_managed_history=True,
    )
    return agent, llm


async def _ask_for_color(agent):
    user = UserMessage(id="u-1", role="user", content="Pick a color")
    turn1 = await collect(agent, _delta("r1", [user], None, tools=[PICK_COLOR]))
    run_finished(turn1)
    call_id, _ = tool_call(turn1, "pick_color")
    assert call_id
    return call_id


def _confirm_agent(store, *, proposes=True):
    def write_document_local(document: str) -> dict:
        """Write the document."""
        return {"status": "written"}

    llm = ScriptedLlm(
        model="scripted",
        first_call=(
            {"name": "write_document_local", "args": {"document": "Hi"}} if proposes else None
        ),
    )
    agent = ADKAgent(
        adk_agent=LlmAgent(name="doc_agent", model=llm, tools=[write_document_local]),
        app_name=APP,
        user_id=USER,
        session_service=store,
        predict_state=[
            PredictStateMapping(
                state_key="document",
                tool="write_document_local",
                tool_argument="document",
            )
        ],
        server_managed_history=True,
    )
    return agent, llm


async def _propose(agent):
    user = UserMessage(id="u-1", role="user", content="Write it")
    turn1 = await collect(agent, _input(THREAD, "r1", [user]))
    run_finished(turn1)
    confirm_id, _ = tool_call(turn1, "confirm_changes")
    assert confirm_id
    return confirm_id


def _stored_call(call_id, name):
    return Event(
        author="assistant",
        content=types.Content(
            role="model",
            parts=[types.Part(function_call=types.FunctionCall(id=call_id, name=name, args={}))],
        ),
    )


class TestDeltaToolResults:
    @pytest.mark.parametrize("resumable", [False, True], ids=["plain", "resumable"])
    @pytest.mark.parametrize("with_owner", [False, True], ids=["result_only", "with_owner"])
    async def test_frontend_tool_result_reaches_model_with_its_name(self, resumable, with_owner):
        agent, llm = _frontend_agent(resumable)
        call_id = await _ask_for_color(agent)

        result = ToolMessage(
            id="tr-1", role="tool", tool_call_id=call_id, content='{"color": "blue"}'
        )
        delta = ([_owner(call_id, "pick_color")] if with_owner else []) + [result]
        turn2 = await collect(agent, _delta("r2", delta, "u-1", tools=[PICK_COLOR]))

        assert not _errors(turn2), turn2
        run_finished(turn2)
        assert llm.turn_count == 2
        responses = _function_responses(llm.last_contents[-1])
        # ADK strips call ids before the model request; the name is what matters.
        assert [r.name for r in responses] == ["pick_color"]
        assert responses[0].response == {"color": "blue"}

    async def test_session_names_fill_only_missing_ids(self):
        """A name the incoming messages give wins over the stored one."""
        agent, _ = _frontend_agent(False)
        call_id = await _ask_for_color(agent)

        delta = [
            _owner(call_id, "renamed"),
            ToolMessage(id="tr-1", role="tool", tool_call_id=call_id, content="{}"),
            ToolMessage(id="tr-2", role="tool", tool_call_id="never-called", content="{}"),
        ]
        results = await agent._extract_tool_results(_delta("r2", delta, "u-1"))

        assert [(r["message"].id, r["tool_name"]) for r in results] == [
            ("tr-1", "renamed"),
            ("tr-2", "unknown"),
        ]

    async def test_session_is_not_read_when_every_name_is_known(self):
        agent, _ = _frontend_agent(False)
        call_id = await _ask_for_color(agent)

        async def fail(*args, **kwargs):
            raise AssertionError("session lookup is only for missing names")

        agent._session_call_names_for_thread = fail
        delta = [
            _owner(call_id, "pick_color"),
            ToolMessage(id="tr-1", role="tool", tool_call_id=call_id, content="{}"),
        ]
        results = await agent._extract_tool_results(_delta("r2", delta, "u-1"))

        assert [r["tool_name"] for r in results] == ["pick_color"]

    def test_stored_names_resolve_by_client_facing_id(self):
        """An LRO call whose client id was remapped resolves by either id."""
        session = type("Session", (), {"events": [_stored_call("adk-1", "pick_color")]})()

        names = ADKAgent._session_function_call_names(session, {"client-1": "adk-1"})

        assert names == {"adk-1": "pick_color", "client-1": "pick_color"}

    def test_answered_calls_get_no_stored_name(self):
        """A re-sent result for an answered call is not dressed as a live one."""
        answered = Event(
            author="user",
            content=types.Content(
                role="user",
                parts=[
                    types.Part(
                        function_response=types.FunctionResponse(
                            id="adk-1", name="pick_color", response={}
                        )
                    )
                ],
            ),
        )
        session = type(
            "Session",
            (),
            {"events": [_stored_call("adk-1", "pick_color"), answered, _stored_call("adk-2", "lookup")]},
        )()

        assert ADKAgent._session_function_call_names(session, {}) == {"adk-2": "lookup"}


class TestDeltaConfirmChanges:
    @pytest.mark.parametrize("same_instance", [True, False], ids=["same", "other_instance"])
    @pytest.mark.parametrize("with_owner", [False, True], ids=["result_only", "with_owner"])
    async def test_decision_reaches_model_as_text(self, same_instance, with_owner):
        store = InMemorySessionService()
        agent, llm = _confirm_agent(store)
        confirm_id = await _propose(agent)
        if not same_instance:
            # Another pod: shared store, nothing in memory.
            SessionManager.reset_instance()
            agent, llm = _confirm_agent(store, proposes=False)
        turns_before = llm.turn_count

        rejection = ToolMessage(
            id="t-1", role="tool", tool_call_id=confirm_id, content='{"accepted":false}'
        )
        delta = ([_owner(confirm_id, "confirm_changes")] if with_owner else []) + [rejection]
        # The client's latest confirmed message is the confirm_changes call,
        # which it names after the call id.
        turn2 = await collect(agent, _delta("r2", delta, confirm_id))

        assert not _errors(turn2), turn2
        run_finished(turn2)
        assert llm.turn_count == turns_before + 1
        last = llm.last_contents[-1]
        assert _function_responses(last) == []
        assert REJECTION in content_text(last).lower()
        session = await agent._session_manager._find_session_by_thread_id(APP, USER, THREAD)
        assert session.state.get(PENDING_CONFIRM_CHANGES_STATE_KEY) == []

    async def test_owner_claiming_another_name_does_not_forward_the_decision(self):
        """A pending confirmation is confirm_changes whatever the upload claims."""
        agent, _ = _confirm_agent(InMemorySessionService())
        confirm_id = await _propose(agent)

        delta = [
            _owner(confirm_id, "write_document_local"),
            ToolMessage(id="t-1", role="tool", tool_call_id=confirm_id, content='{"accepted":true}'),
        ]
        run = _delta("r2", delta, "u-1")

        assert await agent._extract_tool_results(run) == []
        decisions = await agent._extract_confirm_changes_decisions(run, delta)
        assert [message.id for message, _ in decisions] == ["t-1"]


class TestConfirmChangesCursor:
    async def test_pending_confirm_call_id_is_a_cursor_until_decided(self):
        agent, _ = _confirm_agent(InMemorySessionService())
        confirm_id = await _propose(agent)

        pending = await agent._check_history_cursor(
            _delta("r2", [], confirm_id), USER, app_name=APP
        )
        assert pending is None

        rejection = ToolMessage(
            id="t-1", role="tool", tool_call_id=confirm_id, content='{"accepted":false}'
        )
        decided = await collect(agent, _delta("r2", [rejection], confirm_id))
        run_finished(decided)

        # The snapshot's messages are confirmed, so any of them can be the next
        # cursor, including tool messages (stable ids derived from the event).
        snapshot = [e for e in decided if e.type == EventType.MESSAGES_SNAPSHOT][-1]
        tool_ids = [m.id for m in snapshot.messages if m.role == "tool"]
        assert tool_ids
        for message in snapshot.messages:
            assert await agent._check_history_cursor(
                _delta("r3", [], message.id), USER, app_name=APP
            ) is None, message

        # Consumed: the client's cursor has moved on to the decision run.
        stale = await agent._check_history_cursor(
            _delta("r3", [], confirm_id), USER, app_name=APP
        )
        assert stale is not None and stale.code == "HISTORY_UNAVAILABLE"

    async def test_confirm_id_held_only_in_memory_is_a_cursor(self):
        """A failed state write leaves the id in this instance's record."""
        agent, _ = _confirm_agent(InMemorySessionService())
        confirm_id = await _propose(agent)
        session = await agent._session_manager._find_session_by_thread_id(APP, USER, THREAD)
        await agent._session_manager.set_state_value(
            session_id=session.id,
            app_name=APP,
            user_id=USER,
            key=PENDING_CONFIRM_CHANGES_STATE_KEY,
            value=[],
        )

        assert await agent._check_history_cursor(
            _delta("r2", [], confirm_id), USER, app_name=APP
        ) is None

    async def test_snapshot_tool_message_ids_are_stable(self):
        agent, _ = _confirm_agent(InMemorySessionService())
        await _propose(agent)
        session = await agent._session_manager._find_session_by_thread_id(APP, USER, THREAD)

        first = [m.id for m in adk_events_to_messages(session.events) if m.role == "tool"]
        second = [m.id for m in adk_events_to_messages(session.events) if m.role == "tool"]

        assert first and first == second


class TestDeltaResume:
    async def test_resume_of_stored_call_that_is_not_pending_is_rejected(self):
        """Stored in the session but not pending: the entry cannot be correlated.

        Only pending calls and open interrupts can be resumed. A stored call
        that does not pause the run is history, so the resume entry ends the
        run with RUN_ERROR and the model is not called.
        """
        model = RecordingModel(context_sizes=[])
        service = InMemorySessionService()
        agent = _agent(model, service, server_managed_history=True)
        await _run(agent, _input(THREAD, "r1", [_user("u1", "first")]))
        session_id = (await service.list_sessions(app_name=APP, user_id=USER)).sessions[0].id
        session = await service.get_session(app_name=APP, user_id=USER, session_id=session_id)
        await service.append_event(session, _stored_call("call-1", "lookup"))

        events = await _run(
            agent,
            _delta(
                "r2",
                [],
                "u1",
                resume=[ResumeEntry(interrupt_id="call-1", status="resolved", payload={})],
            ),
        )

        errors = _errors(events)
        assert len(errors) == 1 and "call-1" in errors[0].message
        assert not [e for e in events if e.type == EventType.RUN_FINISHED]
        assert model.context_sizes == [1]


class TestDeltaSystemMessage:
    async def test_system_message_sent_with_delta_sets_instructions(self):
        class InstructionRecordingModel(RecordingModel):
            instructions: list = []

            async def generate_content_async(self, llm_request, stream=False):
                self.instructions.append(str(llm_request.config.system_instruction or ""))
                async for response in super().generate_content_async(llm_request, stream):
                    yield response

        model = InstructionRecordingModel(context_sizes=[], instructions=[])
        agent = _agent(model, InMemorySessionService(), server_managed_history=True)
        system = {"id": "s1", "role": "system", "content": "Answer in French."}
        first = await _run(agent, _input(THREAD, "r1", [system, _user("u1", "first")]))
        cursor = _assistant_text_id(first)

        second = await _run(
            agent, _input(THREAD, "r2", [system, _user("u2", "second")], cursor=cursor)
        )

        assert second[-1].type == EventType.RUN_FINISHED, second
        assert len(model.instructions) == 2
        assert all("Answer in French." in text for text in model.instructions)
        # Applied as instructions, not stored as conversation turns.
        assert model.context_sizes == [1, 3]


class TestMessagesSnapshotDefault:
    def test_on_by_default_with_server_managed_history(self):
        agent = _agent(RecordingModel(), InMemorySessionService(), server_managed_history=True)
        assert agent._emit_messages_snapshot is True

    def test_explicit_false_wins(self):
        agent = _agent(
            RecordingModel(),
            InMemorySessionService(),
            server_managed_history=True,
            emit_messages_snapshot=False,
        )
        assert agent._emit_messages_snapshot is False

    def test_off_by_default_without_server_managed_history(self):
        assert _agent(RecordingModel(), InMemorySessionService())._emit_messages_snapshot is False

    def test_from_app_follows_the_flag(self):
        app = App(name=APP, root_agent=LlmAgent(name="assistant", model=RecordingModel()))
        agent = ADKAgent.from_app(app, user_id=USER, server_managed_history=True)
        assert agent._emit_messages_snapshot is True

    async def test_delta_run_ends_with_snapshot_from_the_store(self):
        agent = _agent(
            RecordingModel(context_sizes=[]), InMemorySessionService(), server_managed_history=True
        )
        first = await _run(agent, _input(THREAD, "r1", [_user("u1", "first")]))

        second = await _run(
            agent, _input(THREAD, "r2", [_user("u2", "second")], cursor=_assistant_text_id(first))
        )

        snapshots = [e for e in second if e.type == EventType.MESSAGES_SNAPSHOT]
        assert len(snapshots) == 1
        # The delta carried one message; the snapshot holds both turns.
        assert [m.role for m in snapshots[0].messages] == ["user", "assistant", "user", "assistant"]
