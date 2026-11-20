"""The confirm_changes decision survives a hop to another instance.

Two ADKAgent instances share one session store (as two pods share a database)
but nothing in memory: each builds its own SessionManager, so processed-message
tracking and the open-interrupt record start empty on the second instance. The
open confirm_changes ids therefore have to live in ADK session state.
"""

import pytest

from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from ag_ui_adk import ADKAgent, PredictStateMapping
from ag_ui_adk.adk_agent import PENDING_CONFIRM_CHANGES_STATE_KEY
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents.llm_agent import LlmAgent
from google.adk.sessions import InMemorySessionService

from tests.hitl_helpers import (
    ScriptedLlm,
    collect,
    content_text,
    run_finished,
    run_input,
    tool_call,
)

THREAD = "t-cross-instance"
USER = UserMessage(id="u-1", role="user", content="Write it")
REJECTION = "user rejected the proposed changes"


@pytest.fixture(autouse=True)
def reset_session_manager():
    SessionManager.reset_instance()
    yield
    SessionManager.reset_instance()


def _instance(store: InMemorySessionService, *, proposes: bool = True):
    """One pod: its own SessionManager and caches over the shared store.

    Only the proposing pod's model calls the predictive tool; the others just
    reply, so their turn counts measure exactly what reached the model.
    """

    def write_document_local(document: str) -> dict:
        """Write the document."""
        return {"status": "written"}

    llm = ScriptedLlm(
        model="scripted",
        first_call={"name": "write_document_local", "args": {"document": "Hi"}} if proposes else None,
    )
    agent = ADKAgent(
        adk_agent=LlmAgent(name="doc_agent", model=llm, tools=[write_document_local]),
        app_name="doc_app",
        user_id="test_user",
        session_service=store,
        predict_state=[
            PredictStateMapping(
                state_key="document",
                tool="write_document_local",
                tool_argument="document",
            )
        ],
    )
    return agent, llm


async def _propose(agent):
    events = await collect(agent, run_input(THREAD, "run-1", [USER]))
    write_id, write_args = tool_call(events, "write_document_local")
    confirm_id, _ = tool_call(events, "confirm_changes")
    assert write_id and confirm_id
    history = [
        USER,
        AssistantMessage(
            id="a-1",
            role="assistant",
            content=None,
            tool_calls=[
                ToolCall(
                    id=write_id,
                    function=FunctionCall(name="write_document_local", arguments=write_args),
                ),
                ToolCall(
                    id=confirm_id,
                    function=FunctionCall(name="confirm_changes", arguments="{}"),
                ),
            ],
        ),
    ]
    return events, confirm_id, history


def _rejection(confirm_id):
    return ToolMessage(id="t-1", role="tool", tool_call_id=confirm_id, content='{"accepted":false}')


async def _session_state(agent):
    session = await agent._session_manager._find_session_by_thread_id("doc_app", "test_user", THREAD)
    return dict(session.state)


def _assert_well_formed(events):
    assert events[0].type == EventType.RUN_STARTED
    assert not [e for e in events if e.type == EventType.RUN_ERROR]
    run_finished(events)


def _snapshots(events):
    return [e.snapshot for e in events if e.type == EventType.STATE_SNAPSHOT]


class TestConfirmChangesAcrossInstances:
    @pytest.mark.asyncio
    async def test_rejection_on_second_instance_reaches_model(self):
        store = InMemorySessionService()
        agent_a, _ = _instance(store)
        _, confirm_id, history = await _propose(agent_a)
        assert (await _session_state(agent_a))[PENDING_CONFIRM_CHANGES_STATE_KEY] == [confirm_id]

        agent_b, llm_b = _instance(store, proposes=False)
        turn2 = await collect(agent_b, run_input(THREAD, "run-2", history + [_rejection(confirm_id)]))

        _assert_well_formed(turn2)
        assert llm_b.turn_count == 1, "instance B must hand the decision to the model once"
        text = content_text(llm_b.last_contents[-1])
        assert REJECTION in text.lower()
        # The replayed first user message is history, not a new request.
        assert "Write it" not in text
        # Consumed on hand-off.
        assert (await _session_state(agent_b)).get(PENDING_CONFIRM_CHANGES_STATE_KEY) == []

    @pytest.mark.asyncio
    async def test_answered_decision_in_history_starts_no_turn_on_fresh_instance(self):
        store = InMemorySessionService()
        agent_a, llm_a = _instance(store)
        _, confirm_id, history = await _propose(agent_a)
        answered = history + [_rejection(confirm_id)]
        await collect(agent_a, run_input(THREAD, "run-2", answered))
        turns_on_a = llm_a.turn_count

        agent_c, llm_c = _instance(store, proposes=False)
        replay = await collect(
            agent_c,
            run_input(
                THREAD,
                "run-3",
                answered + [AssistantMessage(id="a-2", role="assistant", content="Done.")],
            ),
        )

        _assert_well_formed(replay)
        assert llm_c.turn_count == 0
        assert llm_a.turn_count == turns_on_a

    @pytest.mark.asyncio
    async def test_answered_decision_is_not_resent_with_a_new_message_on_fresh_instance(self):
        store = InMemorySessionService()
        agent_a, _ = _instance(store)
        _, confirm_id, history = await _propose(agent_a)
        answered = history + [_rejection(confirm_id)]
        await collect(agent_a, run_input(THREAD, "run-2", answered))

        agent_c, llm_c = _instance(store, proposes=False)
        turn = await collect(
            agent_c,
            run_input(
                THREAD,
                "run-3",
                answered
                + [
                    AssistantMessage(id="a-2", role="assistant", content="Done."),
                    UserMessage(id="u-2", role="user", content="Now add a title"),
                ],
            ),
        )

        _assert_well_formed(turn)
        assert llm_c.turn_count == 1
        text = content_text(llm_c.last_contents[-1])
        assert "Now add a title" in text
        assert REJECTION not in text.lower()


    @pytest.mark.asyncio
    async def test_resume_without_history_on_second_instance_reaches_model(self):
        from ag_ui.core import ResumeEntry

        store = InMemorySessionService()
        agent_a, _ = _instance(store)
        _, confirm_id, _ = await _propose(agent_a)

        agent_b, llm_b = _instance(store, proposes=False)
        turn2 = await collect(
            agent_b,
            run_input(
                THREAD,
                "run-2",
                [USER],
                resume=[ResumeEntry(interrupt_id=confirm_id, status="resolved", payload={"accepted": False})],
            ),
        )

        _assert_well_formed(turn2)
        assert llm_b.turn_count == 1
        assert REJECTION in content_text(llm_b.last_contents[-1]).lower()


class TestPendingConfirmChangesStateKey:
    @pytest.mark.asyncio
    async def test_key_never_reaches_client_snapshots(self):
        store = InMemorySessionService()
        agent, _ = _instance(store)
        events, confirm_id, history = await _propose(agent)
        assert (await _session_state(agent))[PENDING_CONFIRM_CHANGES_STATE_KEY] == [confirm_id]
        assert _snapshots(events), "the proposal run sends state snapshots"
        turn2 = await collect(agent, run_input(THREAD, "run-2", history + [_rejection(confirm_id)]))

        for snapshot in _snapshots(events) + _snapshots(turn2):
            assert PENDING_CONFIRM_CHANGES_STATE_KEY not in snapshot

    @pytest.mark.asyncio
    async def test_frontend_state_cannot_overwrite_key(self):
        store = InMemorySessionService()
        agent_a, _ = _instance(store)
        _, confirm_id, history = await _propose(agent_a)

        agent_b, llm_b = _instance(store, proposes=False)
        turn2 = await collect(
            agent_b,
            run_input(
                THREAD,
                "run-2",
                history + [_rejection(confirm_id)],
                state={PENDING_CONFIRM_CHANGES_STATE_KEY: [], "document": "Hi"},
            ),
        )

        _assert_well_formed(turn2)
        assert llm_b.turn_count == 1
        assert REJECTION in content_text(llm_b.last_contents[-1]).lower()

    @pytest.mark.asyncio
    async def test_frontend_state_cannot_inject_key(self):
        """A client cannot make an old answer look open again."""
        store = InMemorySessionService()
        agent_a, _ = _instance(store)
        _, confirm_id, history = await _propose(agent_a)
        answered = history + [_rejection(confirm_id)]
        await collect(agent_a, run_input(THREAD, "run-2", answered))

        # A run that does execute, carrying the key in frontend state.
        await collect(
            agent_a,
            run_input(
                THREAD,
                "run-3",
                answered + [UserMessage(id="u-2", role="user", content="Hello")],
                state={PENDING_CONFIRM_CHANGES_STATE_KEY: [confirm_id]},
            ),
        )
        assert (await _session_state(agent_a)).get(PENDING_CONFIRM_CHANGES_STATE_KEY) == []

        agent_c, llm_c = _instance(store, proposes=False)
        replay = await collect(agent_c, run_input(THREAD, "run-4", answered))

        _assert_well_formed(replay)
        assert llm_c.turn_count == 0

    @pytest.mark.asyncio
    async def test_runs_without_confirm_changes_do_not_write_key(self):
        store = InMemorySessionService()
        llm = ScriptedLlm(model="scripted")
        agent = ADKAgent(
            adk_agent=LlmAgent(name="plain_agent", model=llm),
            app_name="doc_app",
            user_id="test_user",
            session_service=store,
        )

        manager = agent._session_manager
        written_keys = []
        original_set, original_update = manager.set_state_value, manager.update_session_state

        async def spy_set(session_id, app_name, user_id, key, value):
            written_keys.append(key)
            return await original_set(session_id, app_name, user_id, key, value)

        async def spy_update(session_id, app_name, user_id, state_updates, *args, **kwargs):
            written_keys.extend(state_updates)
            return await original_update(session_id, app_name, user_id, state_updates, *args, **kwargs)

        manager.set_state_value, manager.update_session_state = spy_set, spy_update
        events = await collect(
            agent,
            run_input(
                THREAD,
                "run-1",
                [UserMessage(id="u-1", role="user", content="Hello")],
                state={"document": "Hi"},
            ),
        )

        _assert_well_formed(events)
        assert written_keys, "the spy must observe the run's normal state writes"
        assert PENDING_CONFIRM_CHANGES_STATE_KEY not in written_keys
        assert PENDING_CONFIRM_CHANGES_STATE_KEY not in await _session_state(agent)
