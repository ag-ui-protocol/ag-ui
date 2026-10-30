"""Session lifecycle regressions: lost-session recovery and resume-by-id."""

import asyncio
import inspect

import pytest
from copilot import CopilotClient
from test_agent import FRONTEND_TOOL_TURN, TEXT_TURN, FakeClient, collect, make_input

from ag_ui_copilot_sdk import CopilotAgent
from ag_ui_copilot_sdk import agent as agent_module

TOOLS = [
    {
        "name": "change_background",
        "description": "change it",
        "parameters": {"type": "object", "properties": {}},
    }
]
USER = {"id": "u1", "role": "user", "content": "Say hello."}
TOOL_RESULT = {"id": "t-1", "role": "tool", "toolCallId": "call-1", "content": "ok"}
RESOLVED_TRANSCRIPT = [
    USER,
    {
        "id": "a1",
        "role": "assistant",
        "toolCalls": [
            {
                "id": "call-1",
                "type": "function",
                "function": {"name": "change_background", "arguments": "{}"},
            }
        ],
    },
    TOOL_RESULT,
]


async def test_l1_resolved_tool_replay_after_timeout_accepts_new_user():
    client = FakeClient(FRONTEND_TOOL_TURN)
    agent = CopilotAgent(client, run_timeout=1)
    first = await collect(agent, make_input(tools=TOOLS))
    assert first[-1].type == "RUN_FINISHED"
    second = await collect(agent, make_input(runId="r2", tools=TOOLS, messages=RESOLVED_TRANSCRIPT))
    assert second[-1].type == "RUN_FINISHED"
    assert [r.request_id for r in client.session.resolved] == ["req-1"]
    assert agent._threads["t1"].pending == {}

    failed_transcript = RESOLVED_TRANSCRIPT + [
        {"id": "u2", "role": "user", "content": "This turn times out."}
    ]
    old_session = client.session
    old_session._stall = True
    agent.run_timeout = 0.02
    failed = await collect(agent, make_input(runId="r3", tools=TOOLS, messages=failed_transcript))
    assert failed[-1].type == "RUN_ERROR"
    assert old_session.aborted
    assert "t1" not in agent._threads

    client._script = TEXT_TURN
    agent.run_timeout = 1
    recovered = await collect(
        agent,
        make_input(
            runId="r4",
            messages=failed_transcript
            + [{"id": "u3", "role": "user", "content": "Continue after the timeout."}],
        ),
    )
    assert recovered[-1].type == "RUN_FINISHED", recovered[-1]
    assert client.session is not old_session
    assert client.session.prompts == ["Continue after the timeout."]
    await agent.close()


async def test_l2_failed_run_resumes_the_same_native_session():
    signature = inspect.signature(CopilotClient.resume_session)
    signature.bind(None, "previous-session", on_event=lambda event: None, tools=[])
    assert "continue_pending_work" in signature.parameters

    client = FakeClient(TEXT_TURN)
    agent = CopilotAgent(client, run_timeout=1)
    assert (await collect(agent, make_input()))[-1].type == "RUN_FINISHED"
    old_session = client.session
    old_session._stall = True
    agent.run_timeout = 0.02
    failed_transcript = [USER, {"id": "u2", "role": "user", "content": "Fail."}]
    assert (await collect(agent, make_input(runId="r2", messages=failed_transcript)))[
        -1
    ].type == "RUN_ERROR"

    agent.run_timeout = 1
    events = await collect(
        agent,
        make_input(
            runId="r3",
            messages=failed_transcript
            + [{"id": "u3", "role": "user", "content": "Recall our earlier conversation."}],
        ),
    )
    assert events[-1].type == "RUN_FINISHED"
    assert client.session is not old_session
    assert client.session.prompts == ["Recall our earlier conversation."]
    assert len(client.stored) == 1
    assert client.resumed == list(client.stored)
    assert client.options.get("cloud") is None

    # Another agent on the same client and threadId gets its own session.
    other = CopilotAgent(client, run_timeout=1)
    assert (await collect(other, make_input(runId="r4")))[-1].type == "RUN_FINISHED"
    assert len(client.stored) == 2 and client.resumed == client.resumed[:1]
    await agent.close()
    await other.close()


@pytest.mark.parametrize("mode", ["tool-replay", "resume-replay", "duplicate-results"])
async def test_l3_replayed_or_duplicate_resolution_is_a_noop(mode):
    client = FakeClient(FRONTEND_TOOL_TURN)
    agent = CopilotAgent(
        client,
        interrupts={"change_background": lambda answer, args: answer},
        run_timeout=1,
    )
    first = await collect(agent, make_input(tools=TOOLS))
    assert first[-1].type == "RUN_FINISHED"
    session = client.session
    transcript = RESOLVED_TRANSCRIPT + (
        [{**TOOL_RESULT, "id": "duplicate-answer"}] if mode == "duplicate-results" else []
    )
    second = await collect(agent, make_input(runId="r2", tools=TOOLS, messages=transcript))
    assert second[-1].type == "RUN_FINISHED", second[-1]
    third = await collect(
        agent,
        make_input(
            runId="r3",
            tools=TOOLS,
            messages=RESOLVED_TRANSCRIPT,
            **(
                {"resume": [{"interruptId": "call-1", "status": "resolved", "payload": "ok"}]}
                if mode == "resume-replay"
                else {}
            ),
        ),
    )
    assert [event.type for event in third] == ["RUN_STARTED", "RUN_FINISHED"], third[-1]
    assert [request.request_id for request in session.resolved] == ["req-1"]
    assert agent._threads["t1"].session is session
    assert not session.aborted
    assert session.prompts == ["Say hello."]
    await agent.close()


async def test_l4a_cache_evicts_least_recently_used_not_first_inserted(monkeypatch):
    monkeypatch.setattr(agent_module, "MAX_THREADS", 2)
    client = FakeClient(TEXT_TURN)
    agent = CopilotAgent(client, run_timeout=1)
    for thread_id in ("a", "b"):
        assert (await collect(agent, make_input(threadId=thread_id)))[-1].type == "RUN_FINISHED"
    first_session = agent._threads["a"].session
    second_session = agent._threads["b"].session
    assert (await collect(agent, make_input(threadId="a", runId="r2")))[-1].type == "RUN_FINISHED"
    assert (await collect(agent, make_input(threadId="c")))[-1].type == "RUN_FINISHED"
    try:
        assert set(agent._threads) == {"a", "c"}
        assert not first_session.aborted
        assert second_session.aborted
    finally:
        await agent.close()


@pytest.mark.parametrize("capacity", [1, 2], ids=["all-busy", "idle-victim"])
async def test_l4b_cache_never_evicts_an_inflight_session(monkeypatch, capacity):
    monkeypatch.setattr(agent_module, "MAX_THREADS", capacity)
    client = FakeClient(TEXT_TURN)
    agent = CopilotAgent(client, run_timeout=1)
    active = agent.run(make_input(threadId="a"))
    assert (await anext(active)).type == "RUN_STARTED"
    assert (await anext(active)).type == "TEXT_MESSAGE_START"
    active_session = client.session
    try:
        if capacity == 2:
            await collect(agent, make_input(threadId="b"))
            idle_session = client.session
        if capacity == 1:
            attempted = await collect(agent, make_input(threadId="c"))
            assert [e.type for e in attempted] == ["RUN_STARTED", "RUN_ERROR"]
            assert "capacity" in attempted[-1].message.lower()
            assert set(agent._threads) == {"a"}
        else:
            attempted = await collect(agent, make_input(threadId="c"))
            assert attempted[-1].type == "RUN_FINISHED"
            assert idle_session.aborted
            assert set(agent._threads) == {"a", "c"}
        assert not active_session.aborted
        assert agent._threads["a"].session is active_session
        assert [e async for e in active][-1].type == "RUN_FINISHED"
    finally:
        await active.aclose()
        await agent.close()


@pytest.mark.parametrize("stop", ["close", "cancel"])
@pytest.mark.parametrize("yield_count", [1, 2], ids=["run-started", "predict-state"])
async def test_l5_early_generator_exit_releases_thread(stop, yield_count):
    client = FakeClient(TEXT_TURN)
    agent = CopilotAgent(
        client,
        predict_state=[{"state_key": "theme", "tool": "paint", "tool_argument": "color"}],
        run_timeout=1,
    )
    await collect(agent, make_input())
    old_thread = agent._threads["t1"]
    stream = agent.run(make_input(runId="r2"))
    try:
        for _ in range(yield_count):
            event = await anext(stream)
        assert event.type == ("RUN_STARTED" if yield_count == 1 else "CUSTOM")
        if stop == "close":
            await stream.aclose()
        else:
            with pytest.raises(asyncio.CancelledError):
                await stream.athrow(asyncio.CancelledError())
        next_run = await collect(
            agent,
            make_input(
                runId="r3",
                messages=[USER, {"id": "u2", "role": "user", "content": "Try again."}],
            ),
        )
        assert agent._threads["t1"] is not old_thread
        assert old_thread.session.aborted
        assert next_run[0].type == "RUN_STARTED"
        assert next_run[-1].type == "RUN_FINISHED"
    finally:
        await stream.aclose()
        await agent.close()


async def test_l5_overlapping_run_is_refused_without_disturbing_the_active_run():
    client = FakeClient(TEXT_TURN)
    agent = CopilotAgent(client, run_timeout=1)
    active = agent.run(make_input())
    assert (await anext(active)).type == "RUN_STARTED"
    try:
        refused = await collect(agent, make_input(runId="overlap"))
        assert [e.type for e in refused] == ["RUN_STARTED", "RUN_ERROR"]
        assert refused[-1].message == "Thread already has an active run"
        assert agent._threads["t1"].busy
        assert [e async for e in active][-1].type == "RUN_FINISHED"
        assert not client.session.aborted
    finally:
        await active.aclose()
        await agent.close()


async def test_tools_changing_between_turns_reach_the_session():
    client = FakeClient(TEXT_TURN)
    agent = CopilotAgent(client, run_timeout=1)
    assert (await collect(agent, make_input()))[-1].type == "RUN_FINISHED"
    assert client.options["tools"] == []
    second = [
        {"id": "u1", "role": "user", "content": "Say hello."},
        {"id": "u2", "role": "user", "content": "Now change the background."},
    ]
    events = await collect(agent, make_input(runId="r2", tools=TOOLS, messages=second))
    assert events[-1].type == "RUN_FINISHED"
    assert [t.name for t in client.options["tools"]] == ["change_background"]
    assert client.session.prompts == ["Now change the background."]
    # Same tools again: the live session is kept.
    live = client.session
    third = second + [{"id": "u3", "role": "user", "content": "Again."}]
    await collect(agent, make_input(runId="r3", tools=TOOLS, messages=third))
    assert client.session is live
    # The input that opened the session, mutated in place and re-sent, still re-opens.
    reused = make_input(
        runId="r4", tools=TOOLS, messages=[{"id": "u9", "role": "user", "content": "Hi."}]
    )
    other = CopilotAgent(client, run_timeout=1)
    await collect(other, reused)
    opened = client.session
    reused.tools.append(reused.tools[0].model_copy(update={"name": "other_tool"}))
    reused.messages.append(make_input().messages[0].model_copy(update={"id": "u10"}))
    await collect(other, reused)
    assert client.session is not opened
    await other.close()
    await agent.close()


async def test_thread_stays_reserved_until_failed_session_is_disconnected():
    client = FakeClient(TEXT_TURN, stall=True)
    closing = asyncio.Event()
    create = client.create_session

    async def slow_abort() -> None:
        closing.set()
        await asyncio.sleep(0.1)

    async def create_with_slow_abort(**options):
        session = await create(**options)
        session.abort = slow_abort
        return session

    client.create_session = create_with_slow_abort
    agent = CopilotAgent(client, run_timeout=0.02)
    first = asyncio.create_task(collect(agent, make_input()))
    await closing.wait()
    # A retry during teardown must not resume the session that is being closed.
    retry = await collect(agent, make_input(runId="r2"))
    assert retry[-1].type == "RUN_ERROR"
    assert retry[-1].message == "Thread already has an active run"
    assert client.resumed == []
    assert (await first)[-1].type == "RUN_ERROR"
    await agent.close()


async def test_cancelled_teardown_still_releases_the_thread():
    client = FakeClient(TEXT_TURN, stall=True)
    closing = asyncio.Event()
    create = client.create_session

    async def slow_abort() -> None:
        closing.set()
        await asyncio.sleep(0.05)

    async def create_with_slow_abort(**options):
        session = await create(**options)
        session.abort = slow_abort
        return session

    client.create_session = create_with_slow_abort
    agent = CopilotAgent(client, run_timeout=0.02)
    first = asyncio.create_task(collect(agent, make_input()))
    await closing.wait()
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    await asyncio.sleep(0.1)
    # Cancelling the caller mid-teardown must not leave the thread reserved forever.
    assert agent._threads == {}
