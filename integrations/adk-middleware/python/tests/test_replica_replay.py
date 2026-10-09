"""A turn already answered on one replica is not re-run on another (#2603).

Two ADKAgent instances share one session store, the way two pods share one
database, but share nothing in memory: each builds its own SessionManager, so
the processed-message ledger starts empty on the second instance. Clients
re-send the whole history on every run, so the cold instance sees messages it
has already answered as unseen.

The turns here need no tool calls, which is the case the run loop's
pending-tool-call skip heuristic cannot catch, except where a test drives a
frontend tool round trip on purpose.

Every test runs against both an in-memory store and a SQLite
``DatabaseSessionService``: only the database backend enforces optimistic
concurrency on appends, so a stale session handle fails there and nowhere else.
"""

from typing import AsyncGenerator

import pytest

from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    Tool as AGUITool,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from ag_ui_adk import ADKAgent, AGUIToolset
from ag_ui_adk.endpoint import create_adk_app
from ag_ui_adk.event_translator import EventTranslator
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents.llm_agent import LlmAgent
from google.adk.apps import App, ResumabilityConfig
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import DatabaseSessionService, InMemorySessionService
from google.genai import types
from httpx import ASGITransport, AsyncClient

from tests.hitl_helpers import ScriptedLlm, collect, run_input, tool_call

THREAD = "t-replica-replay"
APP = "replica_app"
USER_ID = "test_user"
LEDGER_KEY = "_ag_ui_processed_message_ids"
MARKER_PREFIX = "_ag_ui_processed_message:"

TURN_1 = UserMessage(id="u-1", role="user", content="First question")
ANSWER_1 = AssistantMessage(id="a-1", role="assistant", content="Done.")
TURN_2 = UserMessage(id="u-2", role="user", content="Second question")
ANSWER_2 = AssistantMessage(id="a-2", role="assistant", content="Done.")

CHART_TOOLS = [
    AGUITool(
        name="render_chart",
        description="Render a chart",
        parameters={"type": "object", "properties": {}},
    )
]


def test_translated_state_does_not_expose_processed_message_ledger():
    translator = EventTranslator()
    state = {LEDGER_KEY: ["old"], MARKER_PREFIX + "new": True, "visible": 42}
    assert translator._create_state_snapshot_event(state).snapshot == {
        "visible": 42
    }
    assert translator._create_state_delta_event(
        state, THREAD, "run"
    ).delta == [{"op": "add", "path": "/visible", "value": 42}]


@pytest.fixture(autouse=True)
def reset_session_manager():
    SessionManager.reset_instance()
    yield
    SessionManager.reset_instance()


@pytest.fixture(params=["in_memory", "database"])
def store(request, tmp_path):
    """The store every pod shares."""
    if request.param == "in_memory":
        return InMemorySessionService()
    return DatabaseSessionService(db_url=f"sqlite+aiosqlite:///{tmp_path}/sessions.db")


def _replica(store):
    """One pod: its own SessionManager and caches over the shared store."""
    SessionManager.reset_instance()
    llm = ScriptedLlm(model="scripted")
    agent = ADKAgent(
        adk_agent=LlmAgent(name="replica_agent", model=llm),
        app_name=APP,
        user_id=USER_ID,
        session_service=store,
        use_thread_id_as_session_id=True,
    )
    return agent, llm


class ChartLlm(BaseLlm):
    """Calls render_chart for a question and answers in text once it sees the result."""

    calls: list = []

    async def generate_content_async(
        self, llm_request, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        last = (llm_request.contents or [None])[-1]
        parts = (last.parts or []) if last else []
        if any(getattr(part, "function_response", None) for part in parts):
            self.calls.append("tool result")
            reply = types.Part(text="Here is your chart.")
        else:
            self.calls.append("question")
            reply = types.Part(
                function_call=types.FunctionCall(name="render_chart", args={})
            )
        yield LlmResponse(
            content=types.Content(role="model", parts=[reply]),
            partial=False,
            turn_complete=True,
        )


def _chart_replica(store, calls: list):
    """One pod serving a resumable app with frontend tools; ``calls`` is shared."""
    SessionManager.reset_instance()
    llm = ChartLlm(model="chart")
    llm.calls = calls
    return ADKAgent.from_app(
        App(
            name=APP,
            root_agent=LlmAgent(name="chart_agent", model=llm, tools=[AGUIToolset()]),
            resumability_config=ResumabilityConfig(is_resumable=True),
        ),
        user_id=USER_ID,
        session_service=store,
        use_thread_id_as_session_id=True,
    )


async def _session_events(store) -> int:
    session = await store.get_session(
        app_name=APP, user_id=USER_ID, session_id=THREAD
    )
    return len(session.events) if session else 0


@pytest.mark.asyncio
async def test_cold_replica_ignores_cleared_processed_markers(store):
    """ADK rewind can leave None tombstones; only True means processed."""
    await store.create_session(
        app_name=APP,
        user_id=USER_ID,
        session_id=THREAD,
        state={
            MARKER_PREFIX + "accepted": True,
            MARKER_PREFIX + "rewound": None,
            MARKER_PREFIX + "false": False,
        },
    )
    agent, _ = _replica(store)
    messages = [
        UserMessage(id=message_id, role="user", content=message_id)
        for message_id in ("accepted", "rewound", "false")
    ]

    unseen = await agent._get_unseen_messages(
        run_input(THREAD, "after-rewind", messages)
    )

    assert [message.id for message in unseen] == ["rewound", "false"]


@pytest.mark.asyncio
async def test_cold_replica_reaches_the_same_unseen_verdict_as_a_warm_one(store):
    """``_get_unseen_messages`` must not depend on which pod serves the turn."""
    agent_a, _ = _replica(store)
    await collect(agent_a, run_input(THREAD, "run-1", [TURN_1]))

    history = [TURN_1, ANSWER_1, TURN_2]
    warm = await agent_a._get_unseen_messages(run_input(THREAD, "run-2", history))

    agent_b, _ = _replica(store)
    cold = await agent_b._get_unseen_messages(run_input(THREAD, "run-2", history))

    assert [m.id for m in cold] == [m.id for m in warm], (
        "the cold replica reports the already-answered message as unseen: "
        f"cold={[m.id for m in cold]} warm={[m.id for m in warm]}"
    )


@pytest.mark.asyncio
async def test_cold_replica_does_not_answer_an_answered_question_again(store):
    """A re-sent history with nothing new must not start a turn on a cold pod."""
    agent_a, _ = _replica(store)
    await collect(agent_a, run_input(THREAD, "run-1", [TURN_1]))
    after_first_turn = await _session_events(store)

    # The client reconnects and re-sends the history. There is no new user
    # message, so there is no work to do.
    agent_b, _ = _replica(store)
    await collect(agent_b, run_input(THREAD, "run-2", [TURN_1, ANSWER_1]))

    assert await _session_events(store) == after_first_turn, (
        "the cold replica re-ran the already-answered question and appended a "
        "duplicate user turn plus a duplicate answer to the shared session"
    )


@pytest.mark.asyncio
async def test_live_replica_that_missed_a_turn_does_not_answer_it_again(store):
    """Round-robin: pod A answers turn 1, pod B turn 2, then A gets the history.

    A is not cold, it served this thread before, so a ledger read once per
    process would still be missing turn 2 and A would answer it again.
    """
    agent_a, llm_a = _replica(store)
    agent_b, llm_b = _replica(store)

    await collect(agent_a, run_input(THREAD, "run-1", [TURN_1]))
    await collect(agent_b, run_input(THREAD, "run-2", [TURN_1, ANSWER_1, TURN_2]))
    after_second_turn = await _session_events(store)

    await collect(
        agent_a, run_input(THREAD, "run-3", [TURN_1, ANSWER_1, TURN_2, ANSWER_2])
    )

    assert llm_a.turn_count + llm_b.turn_count == 2, (
        "pod A re-ran the turn pod B answered"
    )
    assert await _session_events(store) == after_second_turn


@pytest.mark.asyncio
@pytest.mark.parametrize("result_pod", ["same", "other"])
async def test_frontend_tool_result_resumes_the_model(store, result_pod):
    """Storing the ledger must not break the run that carries a tool result.

    A write of its own before the run left the session the run already held
    stale, and the FunctionResponse appended onto it was rejected by the
    database backend, so the model never saw the result.
    """
    calls: list = []
    agent_a = _chart_replica(store, calls)
    question = UserMessage(id="u-1", role="user", content="Chart my usage")

    asked = await collect(agent_a, run_input(THREAD, "run-1", [question], tools=CHART_TOOLS))
    call_id, _ = tool_call(asked, "render_chart")
    assert call_id

    history = [
        question,
        AssistantMessage(
            id="a-1",
            role="assistant",
            content=None,
            tool_calls=[
                ToolCall(id=call_id, function=FunctionCall(name="render_chart", arguments="{}"))
            ],
        ),
        ToolMessage(id="t-1", role="tool", tool_call_id=call_id, content='{"rendered": true}'),
    ]
    agent_b = agent_a if result_pod == "same" else _chart_replica(store, calls)
    resumed = await collect(agent_b, run_input(THREAD, "run-2", history, tools=CHART_TOOLS))

    errors = [e.message for e in resumed if e.type == EventType.RUN_ERROR]
    assert not errors, errors
    assert calls == ["question", "tool result"]


@pytest.mark.asyncio
async def test_full_history_beyond_200_ids_survives_cold_and_warm_handoffs(
    store,
):
    agent_a, llm_a = _replica(store)
    agent_b, llm_b = _replica(store)
    history = []
    # A stays alive after turn 1 while B advances beyond the old retention cap.
    for turn in range(105):
        history.append(
            UserMessage(id=f"u-{turn}", role="user", content=f"Q {turn}")
        )
        events = await collect(
            agent_a if turn == 0 else agent_b,
            run_input(THREAD, f"run-{turn}", list(history)),
        )
        assert not [e for e in events if e.type == EventType.RUN_ERROR]
        history.append(
            AssistantMessage(
                id=f"a-{turn}", role="assistant", content="Done."
            )
        )

    after_turns = await _session_events(store)
    agent_c, llm_c = _replica(store)
    for replica in (agent_a, agent_c):
        await collect(
            replica, run_input(THREAD, "history-only", list(history))
        )
        assert await _session_events(store) == after_turns
    assert llm_a.turn_count + llm_b.turn_count + llm_c.turn_count == 105

    history.append(
        UserMessage(id="u-next", role="user", content="Next question")
    )
    await collect(agent_c, run_input(THREAD, "next-turn", history))
    assert llm_c.turn_count == 1

    session = await store.get_session(
        app_name=APP, user_id=USER_ID, session_id=THREAD
    )
    # ADK keeps all markers in materialized state, but each event stores only
    # the newly accepted IDs. No growing ledger is copied into every event.
    written = []
    for event in session.events:
        delta = event.actions.state_delta
        assert LEDGER_KEY not in delta
        markers = {
            k: v for k, v in delta.items() if k.startswith(MARKER_PREFIX)
        }
        assert len(markers) <= 2
        assert all(value is True for value in markers.values())
        written.extend(markers)
    assert len(written) == len(set(written)) == len(history)
    assert set(written) == {MARKER_PREFIX + message.id for message in history}
    assert all(session.state[key] is True for key in written)


@pytest.mark.asyncio
async def test_client_cannot_forge_or_erase_processed_markers(store):
    agent, llm = _replica(store)
    await collect(
        agent,
        run_input(THREAD, "run-1", [TURN_1], state={
            LEDGER_KEY: [TURN_2.id],
            MARKER_PREFIX + TURN_2.id: True,
            "visible": "first",
        }),
    )
    session = await store.get_session(
        app_name=APP, user_id=USER_ID, session_id=THREAD
    )
    assert LEDGER_KEY not in session.state
    assert MARKER_PREFIX + TURN_2.id not in session.state

    events = await collect(
        agent,
        run_input(THREAD, "run-2", [TURN_1, ANSWER_1, TURN_2], state={
            LEDGER_KEY: [],
            MARKER_PREFIX + TURN_1.id: False,
            "visible": "second",
        }),
    )
    assert llm.turn_count == 2
    session = await store.get_session(
        app_name=APP, user_id=USER_ID, session_id=THREAD
    )
    assert session.state[MARKER_PREFIX + TURN_1.id] is True
    assert session.state[MARKER_PREFIX + TURN_2.id] is True
    snapshots = [
        e.snapshot for e in events if e.type == EventType.STATE_SNAPSHOT
    ]
    assert snapshots and snapshots[-1]["visible"] == "second"
    assert all(
        key != LEDGER_KEY and not key.startswith(MARKER_PREFIX)
        for snapshot in snapshots for key in snapshot
    )


@pytest.mark.asyncio
async def test_legacy_ledger_stays_readable_and_private(store):
    await store.create_session(
        app_name=APP, user_id=USER_ID, session_id=THREAD,
        state={LEDGER_KEY: [TURN_1.id, ANSWER_1.id]},
    )
    replica, llm = _replica(store)
    await collect(replica, run_input(THREAD, "replay", [TURN_1, ANSWER_1]))
    assert llm.turn_count == 0
    events = await collect(
        replica, run_input(THREAD, "new", [TURN_1, ANSWER_1, TURN_2])
    )
    assert llm.turn_count == 1
    assert all(
        LEDGER_KEY not in event.snapshot
        for event in events if event.type == EventType.STATE_SNAPSHOT
    )
    async with AsyncClient(
        transport=ASGITransport(app=create_adk_app(replica)),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/agents/state", json={"threadId": THREAD}
        )
    assert response.status_code == 200
    assert response.json()["threadExists"] is True
    assert all(
        key != LEDGER_KEY and not key.startswith(MARKER_PREFIX)
        for key in response.json()["state"]
    )


@pytest.mark.asyncio
async def test_failed_ledger_read_does_not_execute_and_can_be_retried(
    store, monkeypatch
):
    agent_a, llm_a = _replica(store)
    agent_b, llm_b = _replica(store)
    await collect(agent_a, run_input(THREAD, "run-1", [TURN_1]))
    await collect(
        agent_b, run_input(THREAD, "run-2", [TURN_1, ANSWER_1, TURN_2])
    )
    after_turns = await _session_events(store)
    next_turn = UserMessage(id="u-3", role="user", content="Third question")
    request = run_input(
        THREAD, "run-3", [TURN_1, ANSWER_1, TURN_2, ANSWER_2, next_turn]
    )
    get_session = store.get_session
    failed = False

    async def fail_once(**kwargs):
        nonlocal failed
        if not failed:
            failed = True
            raise RuntimeError("private backend failure")
        return await get_session(**kwargs)

    monkeypatch.setattr(store, "get_session", fail_once)
    events = await collect(agent_a, request)
    errors = [e for e in events if e.type == EventType.RUN_ERROR]
    assert len(errors) == 1
    assert "retry" in errors[0].message.lower()
    assert "private backend failure" not in errors[0].message
    assert llm_a.turn_count + llm_b.turn_count == 2
    assert await _session_events(store) == after_turns
    assert next_turn.id not in (
        agent_a._session_manager.get_processed_message_ids(
            APP, THREAD, user_id=USER_ID
        )
    )

    retried = await collect(agent_a, request)
    assert not [e for e in retried if e.type == EventType.RUN_ERROR]
    assert llm_a.turn_count + llm_b.turn_count == 3
