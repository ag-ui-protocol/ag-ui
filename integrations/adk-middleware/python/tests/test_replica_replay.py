"""A turn already answered on one replica is not re-run on another (#2603).

Two ADKAgent instances share one session store, the way two pods share one
database, but share nothing in memory: each builds its own SessionManager, so
the processed-message ledger starts empty on the second instance. Clients
re-send the whole history on every run, so the cold instance sees messages it
has already answered as unseen.

The turns here need no tool calls, which is the case the run loop's
pending-tool-call skip heuristic cannot catch.
"""

import pytest

from ag_ui.core import AssistantMessage, UserMessage
from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents.llm_agent import LlmAgent
from google.adk.sessions import InMemorySessionService

from tests.hitl_helpers import ScriptedLlm, collect, run_input

THREAD = "t-replica-replay"
APP = "replica_app"
USER_ID = "test_user"

TURN_1 = UserMessage(id="u-1", role="user", content="First question")
ANSWER_1 = AssistantMessage(id="a-1", role="assistant", content="Done.")
TURN_2 = UserMessage(id="u-2", role="user", content="Second question")


@pytest.fixture(autouse=True)
def reset_session_manager():
    SessionManager.reset_instance()
    yield
    SessionManager.reset_instance()


def _replica(store: InMemorySessionService):
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


async def _session_events(store: InMemorySessionService) -> int:
    session = await store.get_session(
        app_name=APP, user_id=USER_ID, session_id=THREAD
    )
    return len(session.events) if session else 0


@pytest.mark.asyncio
async def test_cold_replica_reaches_the_same_unseen_verdict_as_a_warm_one():
    """``_get_unseen_messages`` must not depend on which pod serves the turn."""
    store = InMemorySessionService()

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
async def test_cold_replica_does_not_answer_an_answered_question_again():
    """A re-sent history with nothing new must not start a turn on a cold pod."""
    store = InMemorySessionService()

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
