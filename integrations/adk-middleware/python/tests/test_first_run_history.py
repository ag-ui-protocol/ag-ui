"""The first run of a new thread carries the client's earlier messages (#2865).

``RunAgentInput.messages`` is the complete history the client shows. When no ADK
session exists for the thread yet, nothing else holds the messages before the
latest user message, so the middleware writes them into the new session before
the run instead of dropping them (or dispatching an old question as new work).
"""

from __future__ import annotations

from typing import AsyncGenerator, List

import pytest

from ag_ui.core import (
    AssistantMessage,
    FunctionCall,
    RunAgentInput,
    SystemMessage,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import DatabaseSessionService, InMemorySessionService
from google.genai import types


AGENT_NAME = "history_agent"


def _describe(part: types.Part) -> str:
    if part.text is not None:
        return part.text
    if part.function_call is not None:
        return f"call:{part.function_call.name}:{part.function_call.id}"
    if part.function_response is not None:
        return f"result:{part.function_response.name}:{part.function_response.id}"
    return "?"


class RecordingLlm(BaseLlm):
    """Answers with fixed text and records the contents of every request."""

    model: str = "recording-llm"
    requests: list = []
    fail_on_call: int = 0

    async def generate_content_async(
        self, llm_request, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        self.requests.append(
            [(c.role, [_describe(p) for p in c.parts or []]) for c in llm_request.contents]
        )
        if len(self.requests) == self.fail_on_call:
            raise RuntimeError("synthetic provider failure")
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="answer")]),
            partial=False,
            turn_complete=True,
        )


@pytest.fixture(autouse=True)
def reset_session_manager():
    SessionManager.reset_instance()
    yield
    SessionManager.reset_instance()


@pytest.fixture(params=["memory", "database"])
def session_service(request, tmp_path):
    if request.param == "memory":
        return InMemorySessionService()
    return DatabaseSessionService(db_url=f"sqlite+aiosqlite:///{tmp_path / 'adk.db'}")


def _agent(llm: RecordingLlm, session_service, **kwargs) -> ADKAgent:
    return ADKAgent(
        adk_agent=LlmAgent(name=AGENT_NAME, model=llm, instruction="Answer."),
        app_name="app",
        user_id="user",
        session_service=session_service,
        use_thread_id_as_session_id=True,
        **kwargs,
    )


async def _run(agent: ADKAgent, messages: List, *, thread_id: str = "thread", run_id: str = "run_1"):
    return [
        event
        async for event in agent.run(
            RunAgentInput(
                thread_id=thread_id,
                run_id=run_id,
                state={},
                messages=messages,
                tools=[],
                context=[],
                forwarded_props={},
            )
        )
    ]


async def _session_events(session_service, thread_id: str = "thread"):
    session = await session_service.get_session(app_name="app", user_id="user", session_id=thread_id)
    return [event for event in session.events if event.content]


def _event_types(events) -> List[str]:
    return [type(event).__name__ for event in events]


def _call(call_id: str, name: str = "search", arguments: str = '{"q": "Ada"}') -> ToolCall:
    return ToolCall(id=call_id, type="function", function=FunctionCall(name=name, arguments=arguments))


TEXT_HISTORY = [
    UserMessage(id="u1", role="user", content="Who is Ada?"),
    AssistantMessage(id="a1", role="assistant", content="Ada Lovelace."),
    UserMessage(id="u2", role="user", content="What is her real name?"),
]


@pytest.mark.asyncio
async def test_text_history_reaches_the_model(session_service):
    llm = RecordingLlm(requests=[])
    agent = _agent(llm, session_service)

    events = await _run(agent, TEXT_HISTORY)

    assert "RunErrorEvent" not in _event_types(events)
    assert llm.requests == [[
        ("user", ["Who is Ada?"]),
        ("model", ["Ada Lovelace."]),
        ("user", ["What is her real name?"]),
    ]]
    stored = await _session_events(session_service)
    assert [(e.author, [_describe(p) for p in e.content.parts]) for e in stored] == [
        ("user", ["Who is Ada?"]),
        (AGENT_NAME, ["Ada Lovelace."]),
        ("user", ["What is her real name?"]),
        (AGENT_NAME, ["answer"]),
    ]
    await agent.close()


@pytest.mark.asyncio
async def test_tool_history_is_one_model_call_with_the_paired_call(session_service):
    """Without seeding, the first user message was dispatched on its own: a second,
    duplicate answer to an old question in the same run."""
    llm = RecordingLlm(requests=[])
    agent = _agent(llm, session_service)

    events = await _run(agent, [
        UserMessage(id="u1", role="user", content="Search for Ada"),
        AssistantMessage(id="a1", role="assistant", tool_calls=[_call("c1")]),
        ToolMessage(id="t1", role="tool", tool_call_id="c1", content='{"hit": "Ada Lovelace"}'),
        UserMessage(id="u2", role="user", content="What is her real name?"),
    ])

    assert _event_types(events).count("TextMessageStartEvent") == 1
    assert llm.requests == [[
        ("user", ["Search for Ada"]),
        ("model", ["call:search:c1"]),
        ("user", ["result:search:c1"]),
        ("user", ["What is her real name?"]),
    ]]
    stored = await _session_events(session_service)
    response = stored[2].content.parts[0].function_response
    assert response.response == {"hit": "Ada Lovelace"}
    await agent.close()


@pytest.mark.asyncio
async def test_unpaired_and_protocol_calls_and_system_messages_are_left_out():
    session_service = InMemorySessionService()
    llm = RecordingLlm(requests=[])
    agent = _agent(llm, session_service)

    await _run(agent, [
        SystemMessage(id="s1", role="system", content="You are terse."),
        UserMessage(id="u1", role="user", content="Search for Ada"),
        AssistantMessage(
            id="a1",
            role="assistant",
            content="Searching.",
            tool_calls=[_call("c1"), _call("c-unanswered")],
        ),
        ToolMessage(id="t1", role="tool", tool_call_id="c1", content='{"hit": "Ada"}'),
        ToolMessage(id="t-orphan", role="tool", tool_call_id="c-unknown", content="{}"),
        AssistantMessage(
            id="a2",
            role="assistant",
            tool_calls=[
                _call("c-confirm", name="adk_request_confirmation", arguments="{}"),
                _call("c-review", name="confirm_changes", arguments="{}"),
            ],
        ),
        ToolMessage(id="t-confirm", role="tool", tool_call_id="c-confirm", content='{"confirmed": true}'),
        ToolMessage(id="t-review", role="tool", tool_call_id="c-review", content='{"accepted": true}'),
        UserMessage(id="u2", role="user", content="And her real name?"),
    ])

    assert llm.requests == [[
        ("user", ["Search for Ada"]),
        ("model", ["Searching.", "call:search:c1"]),
        ("user", ["result:search:c1"]),
        ("user", ["And her real name?"]),
    ]]
    await agent.close()


@pytest.mark.asyncio
async def test_next_run_does_not_seed_or_dispatch_the_history_again(session_service):
    llm = RecordingLlm(requests=[])
    agent = _agent(llm, session_service)
    await _run(agent, TEXT_HISTORY)

    events = await _run(agent, TEXT_HISTORY + [
        AssistantMessage(id="a2", role="assistant", content="answer"),
        UserMessage(id="u3", role="user", content="When was she born?"),
    ], run_id="run_2")

    assert "RunErrorEvent" not in _event_types(events)
    assert len(llm.requests) == 2
    assert llm.requests[1] == [
        ("user", ["Who is Ada?"]),
        ("model", ["Ada Lovelace."]),
        ("user", ["What is her real name?"]),
        ("model", ["answer"]),
        ("user", ["When was she born?"]),
    ]
    await agent.close()


@pytest.mark.asyncio
async def test_existing_session_is_the_source_of_truth():
    """History the client sends for a thread that already has a session is not
    written into it."""
    session_service = InMemorySessionService()
    llm = RecordingLlm(requests=[])
    agent = _agent(llm, session_service)
    await _run(agent, [UserMessage(id="u0", role="user", content="hi")])

    await _run(agent, [
        UserMessage(id="u0", role="user", content="hi"),
        UserMessage(id="u-foreign", role="user", content="from elsewhere"),
        AssistantMessage(id="a-foreign", role="assistant", content="foreign answer"),
        UserMessage(id="u1", role="user", content="next"),
    ], run_id="run_2")

    texts = [p.text for e in await _session_events(session_service) for p in e.content.parts]
    assert "foreign answer" not in texts
    await agent.close()


@pytest.mark.asyncio
async def test_seeding_can_be_turned_off():
    session_service = InMemorySessionService()
    llm = RecordingLlm(requests=[])
    agent = _agent(llm, session_service, seed_first_run_history=False)

    await _run(agent, TEXT_HISTORY)

    assert llm.requests == [[("user", ["What is her real name?"])]]
    await agent.close()


@pytest.mark.asyncio
async def test_retry_after_a_failed_first_run_sends_the_history_once():
    session_service = InMemorySessionService()
    llm = RecordingLlm(requests=[], fail_on_call=1)
    agent = _agent(llm, session_service)

    failed = await _run(agent, TEXT_HISTORY)
    assert _event_types(failed)[-1] == "RunErrorEvent"

    retried = await _run(agent, TEXT_HISTORY, run_id="run_2")

    assert "RunErrorEvent" not in _event_types(retried)
    assert llm.requests[-1] == [
        ("user", ["Who is Ada?"]),
        ("model", ["Ada Lovelace."]),
        ("user", ["What is her real name?"]),
    ]
    await agent.close()


@pytest.mark.asyncio
async def test_seeding_twice_writes_each_event_once():
    """Event ids derive from the thread and message ids, so a second seeding of
    the same session (a concurrent or retried first request) adds nothing."""
    session_service = InMemorySessionService()
    agent = _agent(RecordingLlm(requests=[]), session_service)
    session = await session_service.create_session(app_name="app", user_id="user", session_id="thread")
    run_input = RunAgentInput(
        thread_id="thread", run_id="run_1", state={}, messages=TEXT_HISTORY,
        tools=[], context=[], forwarded_props={},
    )

    for _ in range(2):
        session = await session_service.get_session(app_name="app", user_id="user", session_id="thread")
        await agent._seed_session_history(
            run_input, session, "thread", "app", "user",
            author=AGENT_NAME, messages=TEXT_HISTORY[:2],
        )

    stored = await _session_events(session_service)
    assert [e.content.parts[0].text for e in stored] == ["Who is Ada?", "Ada Lovelace."]
    await agent.close()


@pytest.mark.asyncio
async def test_seeded_events_have_their_own_invocation():
    """ADK takes an invocation's first user text as its question on resume, so
    the seeded history must not share the run's invocation."""
    session_service = InMemorySessionService()
    agent = _agent(RecordingLlm(requests=[]), session_service)

    await _run(agent, TEXT_HISTORY)

    stored = await _session_events(session_service)
    seeded, run_events = stored[:2], stored[2:]
    assert [e.content.parts[0].text for e in seeded] == ["Who is Ada?", "Ada Lovelace."]
    assert len({e.invocation_id for e in seeded}) == 1
    assert seeded[0].invocation_id not in {e.invocation_id for e in run_events}
    await agent.close()


@pytest.mark.asyncio
async def test_seeded_events_keep_their_order_in_database_storage(tmp_path):
    """DatabaseSessionService orders events by a timestamp stored to the
    microsecond, and returns ties in any order. Seeded events must stay apart
    whatever the clock reads: a microsecond step rounds neighbours to the same
    value for about one clock reading in ten at current epoch values."""
    import math

    session_service = DatabaseSessionService(db_url=f"sqlite+aiosqlite:///{tmp_path / 'adk.db'}")
    agent = _agent(RecordingLlm(requests=[]), session_service)
    history = [
        UserMessage(id="u1", role="user", content="Search for Ada"),
        AssistantMessage(id="a1", role="assistant", tool_calls=[_call("c1")]),
        ToolMessage(id="t1", role="tool", tool_call_id="c1", content="{}"),
    ]
    base = 1792454756.077
    for step in range(40):
        thread_id = f"thread-{step}"
        session = await session_service.create_session(app_name="app", user_id="user", session_id=thread_id)
        now = base + step * math.ulp(base)
        for event in agent._history_seed_events(thread_id, AGENT_NAME, history, now=now):
            await session_service.append_event(session, event)

        stored = await _session_events(session_service, thread_id)

        assert [_describe(e.content.parts[0]) for e in stored] == [
            "Search for Ada", "call:search:c1", "result:search:c1",
        ], f"now={now!r}"
        assert stored[-1].timestamp < now
    await agent.close()


TOOL_HISTORY = [
    UserMessage(id="u1", role="user", content="Search for Ada"),
    AssistantMessage(id="a1", role="assistant", tool_calls=[_call("c1")]),
    ToolMessage(id="t1", role="tool", tool_call_id="c1", content='{"hit": "Ada Lovelace"}'),
    UserMessage(id="u2", role="user", content="What is her real name?"),
]


def _fail_seed_append(session_service, position: int):
    """Make the ``position``-th (1-based) seeded event's append raise, once."""
    original = session_service.append_event
    seen = {"count": 0, "failed": False}

    async def append_event(session, event):
        if not seen["failed"] and (event.invocation_id or "").startswith("agui-history-"):
            seen["count"] += 1
            if seen["count"] == position:
                seen["failed"] = True
                raise RuntimeError("synthetic storage failure")
        return await original(session, event)

    session_service.append_event = append_event


@pytest.mark.asyncio
@pytest.mark.parametrize("position", [1, 2, 3])
@pytest.mark.parametrize("cold_adapter", [False, True], ids=["same-adapter", "fresh-adapter"])
@pytest.mark.parametrize("initial_state", [{}, {"topic": "Ada"}], ids=["no-state", "state"])
async def test_retry_resumes_an_interrupted_history_import(
    session_service, position, cold_adapter, initial_state
):
    """A session exists once seeding starts, so a retry must finish the import
    rather than take the half-written session as established."""
    llm = RecordingLlm(requests=[])
    agent = _agent(llm, session_service)
    _fail_seed_append(session_service, position)

    def run_input(run_id):
        return RunAgentInput(
            thread_id="thread", run_id=run_id, state=initial_state, messages=TOOL_HISTORY,
            tools=[], context=[], forwarded_props={},
        )

    failed = [event async for event in agent.run(run_input("run_1"))]
    assert _event_types(failed)[-1] == "RunErrorEvent"
    assert llm.requests == []

    if cold_adapter:
        await agent.close()
        SessionManager.reset_instance()
        agent = _agent(llm, session_service)
    retried = [event async for event in agent.run(run_input("run_2"))]

    assert "RunErrorEvent" not in _event_types(retried)
    assert llm.requests == [[
        ("user", ["Search for Ada"]),
        ("model", ["call:search:c1"]),
        ("user", ["result:search:c1"]),
        ("user", ["What is her real name?"]),
    ]]
    await agent.close()


@pytest.mark.asyncio
async def test_native_session_is_not_seeded(session_service):
    """A session the middleware did not create stays authoritative, even when it
    holds no turns yet."""
    await session_service.create_session(app_name="app", user_id="user", session_id="thread")
    llm = RecordingLlm(requests=[])
    agent = _agent(llm, session_service)

    await _run(agent, TEXT_HISTORY)

    assert llm.requests == [[("user", ["What is her real name?"])]]
    await agent.close()
