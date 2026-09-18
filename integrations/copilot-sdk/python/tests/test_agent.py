import asyncio
import copy
from types import SimpleNamespace

import pytest

from ag_ui_copilot_sdk import CopilotAgent, InputError, ThreadConflict, validate_input


def request(thread="thread", *, messages=None, tools=None, state=None):
    return {
        "threadId": thread,
        "runId": "run",
        "state": state or {},
        "messages": messages
        if messages is not None
        else [{"id": "u", "role": "user", "content": "hello"}],
        "tools": tools or [],
        "context": [],
        "forwardedProps": {},
    }


def frontend():
    return [
        {
            "name": "browser_tool",
            "description": "Return a browser value",
            "parameters": {"type": "object", "properties": {}},
        }
    ]


def result(call="call", content="nonce", identity="result"):
    return {"id": identity, "role": "tool", "toolCallId": call, "content": content}


class FakeSession:
    def __init__(self, on_event, scenario):
        self.handlers = {on_event}
        self.scenario = scenario
        self.session_id = "owned-session"
        self.sends = []
        self.resolutions = []
        self.aborts = self.disconnects = 0
        self.remaining = set()
        self.rpc = SimpleNamespace(tools=SimpleNamespace(handle_pending_tool_call=self.resolve))
        self.sequence = 0

    def on(self, handler):
        self.handlers.add(handler)
        return lambda: self.handlers.discard(handler)

    def emit(self, kind, **data):
        self.sequence += 1
        raw = {"id": str(self.sequence), "type": kind, "data": data}
        for handler in self.handlers.copy():
            handler(SimpleNamespace(to_dict=lambda: raw))

    async def send(self, prompt):
        self.sends.append(prompt)
        if self.scenario in ("frontend", "parallel", "delayed"):
            calls = ["call", "call2"] if self.scenario == "parallel" else ["call"]
            self.remaining.update(calls)
            self.emit(
                "assistant.message",
                messageId="m",
                content="",
                toolRequests=[
                    {"toolCallId": call, "name": "browser_tool", "arguments": {}} for call in calls
                ],
            )
            for call in calls:
                self.emit(
                    "tool.execution_start", toolCallId=call, toolName="browser_tool", arguments={}
                )
                self.emit(
                    "external_tool.requested",
                    toolCallId=call,
                    toolName="browser_tool",
                    requestId=f"rpc:{call}",
                    sessionId=self.session_id,
                )
        elif self.scenario == "hang":
            return
        elif self.scenario == "error":
            self.emit("assistant.message_delta", messageId="m", deltaContent="partial")
            self.emit("session.error", message="Sensitive SDK detail")
        elif self.scenario == "overflow":
            for _ in range(20):
                self.emit("assistant.message_delta", messageId="m", deltaContent="x")
        else:
            self.emit(
                "assistant.message_delta", messageId=f"m{len(self.sends)}", deltaContent="hello"
            )
            self.emit("assistant.message", messageId=f"m{len(self.sends)}", content="hello")
            self.emit("session.idle")

    async def resolve(self, typed):
        from copilot.rpc import HandlePendingToolCallRequest

        assert isinstance(typed, HandlePendingToolCallRequest)
        self.resolutions.append(typed)
        call = typed.request_id.removeprefix("rpc:")
        self.remaining.remove(call)
        self.emit(
            "tool.execution_complete",
            toolCallId=call,
            success=True,
            result={"content": typed.result},
        )
        if not self.remaining:
            self.emit(
                "assistant.message",
                messageId="continued",
                content=f"Original consumed {typed.result}",
            )
            self.emit("session.idle")
        return SimpleNamespace(success=True)

    async def abort(self):
        self.aborts += 1

    async def disconnect(self):
        self.disconnects += 1
        self.handlers.clear()


class FakeClient:
    def __init__(self, scenario="text"):
        self.scenario = scenario
        self.sessions = []
        self.options = []

    async def create_session(self, *, on_event, **kwargs):
        self.options.append(kwargs)
        assert kwargs["streaming"] and kwargs["include_sub_agent_streaming_events"]
        assert kwargs["enable_file_hooks"] is False
        session = FakeSession(on_event, self.scenario)
        self.sessions.append(session)
        session.emit("session.start")
        return session


async def collect(agent, value):
    return [event async for event in agent.run(value)]


def types(events):
    return [event.type.value for event in events]


@pytest.fixture
async def factory():
    agents = []

    def build(scenario="text", **kwargs):
        client = FakeClient(scenario)
        agent = CopilotAgent(client, handoff_delay=0.005, run_timeout=0.2, **kwargs)
        agents.append(agent)
        return agent, client

    yield build
    for agent in agents:
        await agent.close()


@pytest.mark.parametrize(
    "modify",
    [
        lambda x: x.pop("threadId"),
        lambda x: x.update(threadId=""),
        lambda x: x.update(runId=4),
        lambda x: x.update(messages=[{"id": "x", "role": "not-a-role", "content": "no"}]),
        lambda x: x.update(tools=[{"name": "bad/tool", "description": "", "parameters": {}}]),
        lambda x: x.update(tools=frontend() * 2),
        lambda x: x.update(messages=x["messages"] * 2),
        lambda x: x.update(state={"counter": float("nan")}),
    ],
)
def test_malformed_input(modify):
    value = request()
    modify(value)
    with pytest.raises(InputError):
        validate_input(value)


def test_request_limit():
    with pytest.raises(InputError):
        validate_input(request(), max_bytes=1)


async def test_new_turn_only_and_exact_terminal(factory):
    agent, client = factory()
    events = await collect(agent, request())
    assert types(events) == [
        "RUN_STARTED",
        "STATE_SNAPSHOT",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "RUN_FINISHED",
    ]
    second = request(
        messages=[
            {"id": "u", "role": "user", "content": "hello"},
            {"id": "a", "role": "assistant", "content": "old assistant"},
            {"id": "u2", "role": "user", "content": "NEW ONLY"},
        ]
    )
    await collect(agent, second)
    assert len(client.sessions) == 1
    assert "NEW ONLY" in client.sessions[0].sends[-1]
    assert "old assistant" not in client.sessions[0].sends[-1]
    assert "hello" not in client.sessions[0].sends[-1]


@pytest.mark.parametrize(
    "options,expected", [({}, "auto"), ({"model": "explicit-model"}, "explicit-model")]
)
async def test_default_auto_and_explicit_model_are_forwarded(factory, options, expected):
    agent, client = factory(**options)
    await collect(agent, request())
    assert client.options[0]["model"] == expected


async def test_single_original_frontend_continuation_and_duplicate(factory):
    agent, client = factory("frontend")
    first = request(tools=frontend())
    events = await collect(agent, first)
    assert types(events)[-1] == "RUN_FINISHED"
    assert types(events).index("TOOL_CALL_END") < len(events) - 1
    assert "TOOL_CALL_RESULT" not in types(events)
    session = client.sessions[0]
    assert session.disconnects == 0 and session.handlers
    followup = request(tools=frontend(), messages=first["messages"] + [result()])
    events = await collect(agent, followup)
    assert types(events)[0] == "RUN_STARTED"
    assert "TOOL_CALL_RESULT" not in types(events)
    assert any(getattr(event, "delta", "") == "Original consumed nonce" for event in events)
    assert len(session.sends) == len(session.resolutions) == 1
    assert session.resolutions[0].request_id == "rpc:call"
    await collect(agent, followup)
    assert len(session.resolutions) == 1 and len(session.sends) == 1


@pytest.mark.parametrize("scenario", ["frontend", "parallel"])
@pytest.mark.parametrize("keep_declarations", [True, False])
async def test_browser_continuation_never_echoes_replayed_tool_lifecycle(
    factory, scenario, keep_declarations,
):
    agent, client = factory(scenario)
    first = request(tools=frontend())
    await collect(agent, first)
    session = client.sessions[0]
    calls = sorted(session.remaining)
    original_resolve = session.rpc.tools.handle_pending_tool_call

    async def replay_then_resolve(typed):
        call_id = typed.request_id.removeprefix("rpc:")
        session.emit(
            "assistant.message", messageId="m", content="",
            toolRequests=[{"toolCallId": call_id, "name": "browser_tool", "arguments": {}}],
        )
        session.emit("assistant.tool_call_delta", toolCallId=call_id, inputDelta="{}")
        session.emit(
            "tool.execution_start", toolCallId=call_id, toolName="browser_tool", arguments={},
        )
        session.emit(
            "external_tool.requested", toolCallId=call_id, toolName="browser_tool",
            requestId=typed.request_id, sessionId=session.session_id,
        )
        session.emit(
            "tool.execution_complete", toolCallId=call_id, success=True,
            result={"content": typed.result},
        )
        return await original_resolve(typed)

    session.rpc.tools.handle_pending_tool_call = replay_then_resolve
    followup = request(
        tools=frontend() if keep_declarations else [],
        messages=first["messages"] + [
            {
                "id": "m", "role": "assistant", "content": "",
                "toolCalls": [
                    {
                        "id": call_id, "type": "function",
                        "function": {"name": "browser_tool", "arguments": "{}"},
                    }
                    for call_id in calls
                ],
            },
            *[
                result(call_id, '{"nonce":"actual-browser-result"}', f"result:{call_id}")
                for call_id in reversed(calls)
            ],
        ],
    )
    continued = await collect(agent, followup)
    replayed = await collect(agent, followup)
    assert set(types(continued + replayed)).isdisjoint({
        "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT",
    })
    assert any(
        "actual-browser-result" in getattr(event, "delta", "") for event in continued
    )
    assert types(replayed) == ["RUN_STARTED", "STATE_SNAPSHOT", "RUN_FINISHED"]
    assert {
        event.content["toolCallId"]
        for event in continued
        if event.type.value == "ACTIVITY_SNAPSHOT" and event.content["status"] == "completed"
    } == set(calls)
    assert len(session.sends) == 1
    assert len(session.resolutions) == len(calls)


async def test_parallel_out_of_order_all_results_and_duplicate_in_request(factory):
    agent, client = factory("parallel")
    value = request(tools=frontend())
    events = await collect(agent, value)
    assert types(events).count("TOOL_CALL_END") == 2
    followup = request(
        tools=frontend(),
        messages=value["messages"]
        + [
            result("call2", "second", "r2"),
            result("call", "first", "r1"),
            result("call", "first", "duplicate"),
        ],
    )
    events = await collect(agent, followup)
    assert types(events)[-1] == "RUN_FINISHED"
    assert [item.request_id for item in client.sessions[0].resolutions] == ["rpc:call2", "rpc:call"]
    assert len(client.sessions[0].sends) == 1


async def test_parallel_partial_result_returns_handoff_not_hang(factory):
    agent, client = factory("parallel")
    value = request(tools=frontend())
    await collect(agent, value)
    await collect(agent, request(tools=frontend(), messages=value["messages"] + [result("call2")]))
    assert set(agent.threads["thread"].pending) == {"call"}
    await collect(agent, request(tools=frontend(), messages=value["messages"] + [result("call")]))
    assert not agent.threads["thread"].pending
    assert len(client.sessions[0].resolutions) == 2


async def test_wrong_thread_stale_missing_conflicting_results_do_not_destroy_pending(factory):
    agent, client = factory("frontend")
    value = request(tools=frontend())
    await collect(agent, value)
    with pytest.raises(ThreadConflict, match="wrong-thread"):
        await collect(agent, request("wrong", tools=frontend(), messages=[result()]))
    with pytest.raises(ThreadConflict, match="Missing"):
        await collect(agent, value)
    with pytest.raises(ThreadConflict, match="Conflicting"):
        await collect(
            agent,
            request(
                tools=frontend(),
                messages=[
                    result(content="one"),
                    result(content="two", identity="r2"),
                ],
            ),
        )
    assert agent.threads["thread"].pending and client.sessions[0].disconnects == 0
    await agent.cancel("thread")
    assert client.sessions[0].disconnects == 1 and not client.sessions[0].handlers
    with pytest.raises(ThreadConflict):
        await collect(agent, request(tools=frontend(), messages=[result()]))


async def test_changed_result_or_tool_declaration_rejected(factory):
    agent, _ = factory("frontend")
    value = request(tools=frontend())
    await collect(agent, value)
    changed = copy.deepcopy(value)
    changed["tools"][0]["description"] = "different"
    with pytest.raises(ThreadConflict, match="declarations"):
        await collect(agent, changed)
    await collect(agent, request(tools=frontend(), messages=[result()]))
    with pytest.raises(ThreadConflict, match="changed") as conflict:
        await collect(agent, request(tools=frontend(), messages=[result(content="altered")]))
    assert conflict.value.code == "FRONTEND_TOOL_RESULT_CONFLICT"


async def test_same_thread_conflict_independent_threads(factory):
    agent, _ = factory()
    stream = agent.run(request())
    await anext(stream)
    with pytest.raises(ThreadConflict, match="active"):
        await collect(agent, request())
    assert types(await collect(agent, request("independent")))[-1] == "RUN_FINISHED"
    await stream.aclose()
    assert "thread" not in agent.threads


@pytest.mark.parametrize("scenario", ["error", "overflow", "hang"])
async def test_error_timeout_overflow_terminal_cleanup(factory, scenario):
    agent, client = factory(scenario, max_queue=4 if scenario == "overflow" else 256)
    events = await collect(agent, request())
    assert types(events)[-1] == "RUN_ERROR"
    assert "RUN_FINISHED" not in types(events)
    assert "Sensitive SDK detail" not in str(events)
    assert client.sessions[0].disconnects == 1 and not client.sessions[0].handlers
    assert not agent.threads


async def test_disconnect_closes_orphan_listener_and_session(factory):
    agent, client = factory()
    stream = agent.run(request())
    await anext(stream)
    await anext(stream)
    await stream.aclose()
    assert client.sessions[0].aborts == client.sessions[0].disconnects == 1
    assert not client.sessions[0].handlers


async def test_cancel_waiting_request_and_shutdown(factory):
    agent, client = factory("hang")
    task = asyncio.create_task(collect(agent, request()))
    await asyncio.sleep(0.01)
    await agent.cancel("thread")
    with pytest.raises(asyncio.CancelledError):
        await task
    assert client.sessions[0].disconnects == 1
    await agent.close()
    assert agent._reaper.done()


async def test_capacity_expiry_and_close(factory):
    agent, client = factory("frontend", max_threads=1, idle_ttl=0.015)
    await collect(agent, request(tools=frontend()))
    with pytest.raises(ThreadConflict, match="capacity"):
        await collect(agent, request("other"))
    await asyncio.sleep(0.04)
    assert not agent.threads
    assert client.sessions[0].disconnects == 1
    with pytest.raises(ThreadConflict):
        await collect(agent, request(tools=frontend(), messages=[result()]))


async def test_early_callback_and_ownership_mismatch(factory):
    agent, client = factory("frontend")
    stream = agent.run(request(tools=frontend()))
    await anext(stream)
    client.sessions[0].emit(
        "external_tool.requested",
        toolCallId="bad",
        toolName="browser_tool",
        requestId="x",
        sessionId="not-owned",
    )
    events = [event async for event in stream]
    assert types(events)[-1] == "RUN_ERROR"


async def test_create_failure_and_noop_empty_user(factory):
    agent, _ = factory()
    with pytest.raises(InputError):
        await collect(agent, request(messages=[]))
    assert not agent.threads
    with pytest.raises(InputError):
        await collect(agent, request(messages=[{"id": "u", "role": "user", "content": ""}]))


async def test_failed_pending_rpc_has_one_error_and_cleans_up(factory):
    agent, client = factory("frontend")
    await collect(agent, request(tools=frontend()))

    async def fail(_):
        return SimpleNamespace(success=False)

    client.sessions[0].rpc.tools.handle_pending_tool_call = fail
    events = await collect(agent, request(tools=frontend(), messages=[result()]))
    assert types(events)[-1] == "RUN_ERROR"
    assert types(events).count("RUN_ERROR") == 1
    assert not agent.threads and not client.sessions[0].handlers


async def test_oversized_native_event_wakes_consumer_and_cleans_up(factory):
    agent, client = factory(max_event_bytes=200)
    stream = agent.run(request())
    await anext(stream)
    client.sessions[0].emit("assistant.message_delta", messageId="big", deltaContent="x" * 1000)
    events = [event async for event in stream]
    assert types(events)[-1] == "RUN_ERROR"
    assert client.sessions[0].disconnects == 1


async def test_state_rejection_preserves_pending_request(factory):
    def validate(current, incoming):
        if incoming.get("bad"):
            raise ValueError("bad state")
        return current or {}

    agent, client = factory("frontend", state_validator=validate)
    await collect(agent, request(tools=frontend()))
    with pytest.raises(ValueError, match="bad state"):
        await collect(agent, request(tools=frontend(), messages=[result()], state={"bad": True}))
    assert agent.threads["thread"].pending and client.sessions[0].resolutions == []
    await collect(agent, request(tools=frontend(), messages=[result()]))


async def test_duplicate_sdk_request_and_reused_request_id(factory):
    agent, client = factory("frontend")
    stream = agent.run(request(tools=frontend()))
    await anext(stream)
    session = client.sessions[0]
    session.emit(
        "external_tool.requested",
        toolCallId="call",
        toolName="browser_tool",
        requestId="rpc:call",
        sessionId=session.session_id,
    )
    events = [event async for event in stream]
    assert types(events).count("TOOL_CALL_START") == 1
    assert len(agent.threads["thread"].pending) == 1
    followup = agent.run(request(tools=frontend(), messages=[result()]))
    await anext(followup)
    session.emit(
        "external_tool.requested",
        toolCallId="callx",
        toolName="browser_tool",
        requestId="rpc:call",
        sessionId=session.session_id,
    )
    # The old owned request resolves before this stale event. It must not become a new owner.
    events = [event async for event in followup]
    assert types(events)[-1] == "RUN_ERROR"
    assert not session.handlers


async def test_parked_tool_stays_registered_when_continuation_omits_declaration(factory):
    agent, client = factory("frontend")
    await collect(agent, request(tools=frontend()))
    events = await collect(agent, request(messages=[result()]))
    assert types(events)[-1] == "RUN_FINISHED"
    assert "TOOL_CALL_RESULT" not in types(events)
    assert agent.threads["thread"].frontend_names == {"browser_tool"}
    assert len(client.sessions[0].resolutions) == len(client.sessions[0].sends) == 1
    replay = await collect(agent, request(messages=[result()]))
    assert types(replay) == ["RUN_STARTED", "STATE_SNAPSHOT", "RUN_FINISHED"]


async def test_parallel_answer_replay_while_another_result_remains_parked(factory):
    agent, client = factory("parallel")
    await collect(agent, request(tools=frontend()))
    answer = request(tools=frontend(), messages=[result("call2")])
    await collect(agent, answer)
    replay = await collect(agent, answer)
    assert types(replay) == ["RUN_STARTED", "STATE_SNAPSHOT", "RUN_FINISHED"]
    assert set(agent.threads["thread"].pending) == {"call"}
    assert len(client.sessions[0].resolutions) == 1
    await collect(
        agent, request(tools=frontend(), messages=[result("call2"), result("call", identity="r2")])
    )
    assert len(client.sessions[0].resolutions) == 2


async def test_browser_result_suppression_does_not_hide_backend_results(factory):
    from copilot.tools import Tool, ToolResult

    backend = Tool(
        name="lookup",
        description="SDK-handled backend tool",
        parameters={"type": "object", "properties": {}},
        handler=lambda invocation: ToolResult(text_result_for_llm="real backend"),
    )
    agent, client = factory(tools_factory=lambda _: [backend])
    stream = agent.run(request())
    await anext(stream)
    session = client.sessions[0]
    session.emit("tool.execution_start", toolCallId="backend", toolName="lookup", arguments={})
    session.emit(
        "external_tool.requested",
        toolCallId="backend",
        toolName="lookup",
        requestId="backend-rpc",
        sessionId=session.session_id,
        arguments={},
    )
    session.emit(
        "tool.execution_complete",
        toolCallId="backend",
        success=True,
        result={"content": "real backend"},
    )
    events = [event async for event in stream]
    assert [event.content for event in events if event.type.value == "TOOL_CALL_RESULT"] == [
        "real backend"
    ]
    assert types(events)[-1] == "RUN_FINISHED"
    assert not agent.threads["thread"].pending
    assert not agent.threads["thread"].request_owners
    assert not session.resolutions


async def test_child_frontend_handoff_fails_explicitly_without_inferred_suspension(factory):
    agent, client = factory("hang")
    stream = agent.run(request(tools=frontend()))
    await anext(stream)
    session = client.sessions[0]
    session.emit("subagent.started", toolCallId="spawn", agentName="child")
    session.emit(
        "external_tool.requested",
        toolCallId="child-call",
        toolName="browser_tool",
        requestId="child-request",
        sessionId=session.session_id,
        parentToolCallId="spawn",
    )
    events = [event async for event in stream]
    assert types(events)[-1] == "RUN_ERROR"
    assert events[-1].code == "SUBAGENT_FRONTEND_HANDOFF_UNSUPPORTED"
    assert "SUBAGENT_ERROR" in types(events)
    assert "RUN_FINISHED" not in types(events)
    assert not session.handlers


async def test_late_handoff_events_survive_a_stale_idle_marker(factory):
    from ag_ui.core import StateDeltaEvent

    agent, client = factory("frontend")
    first = request(tools=frontend())
    await collect(agent, first)
    session = client.sessions[0]
    thread = agent.threads["thread"]
    session.emit("session.idle")
    session.emit("assistant.message", messageId="late", content="Late source text")
    session.emit("tool.execution_start", toolCallId="backend", toolName="lookup", arguments={})
    thread.state = {"late": True}
    thread.emit(StateDeltaEvent(delta=[{"op": "add", "path": "/late", "value": True}]))
    session.emit(
        "tool.execution_complete", toolCallId="backend", success=True,
        result={"content": "Late backend result"},
    )
    events = await collect(agent, request(tools=frontend(), messages=[result()]))
    assert "Late source text" in [getattr(event, "delta", "") for event in events]
    assert "Original consumed nonce" in [getattr(event, "delta", "") for event in events]
    assert [event.content for event in events if event.type.value == "TOOL_CALL_RESULT"] == [
        "Late backend result"
    ]
    assert types(events).count("STATE_DELTA") == 1
    assert types(events)[-1] == "RUN_FINISHED"
    assert len(session.sends) == 1


async def test_new_prompt_drains_old_source_epoch_before_sending(factory):
    agent, client = factory()
    await collect(agent, request())
    session = client.sessions[0]
    session.emit("session.idle")
    session.emit("assistant.message", messageId="late", content="Late previous turn")
    events = await collect(
        agent, request(messages=[{"id": "new", "role": "user", "content": "new prompt"}])
    )
    assert [
        event.delta for event in events if event.type.value == "TEXT_MESSAGE_CONTENT"
    ] == ["Late previous turn", "hello"]
    assert len(session.sends) == 2 and "new prompt" in session.sends[-1]


async def test_exact_replay_drains_late_source_without_another_send(factory):
    agent, client = factory("frontend")
    await collect(agent, request(tools=frontend()))
    followup = request(tools=frontend(), messages=[result()])
    await collect(agent, followup)
    session = client.sessions[0]
    session.emit("assistant.message", messageId="late", content="Queued after idle")
    events = await collect(agent, followup)
    assert [
        event.delta for event in events if event.type.value == "TEXT_MESSAGE_CONTENT"
    ] == ["Queued after idle"]
    assert types(events)[-1] == "RUN_FINISHED"
    assert len(session.sends) == len(session.resolutions) == 1


@pytest.mark.parametrize("announcement", ["message", "arguments"])
async def test_handoff_waits_for_announced_backend_work(factory, announcement):
    from ag_ui.core import StateDeltaEvent

    agent, client = factory("hang")
    stream = agent.run(request(tools=frontend()))
    await anext(stream)
    session = client.sessions[0]
    calls = [{"toolCallId": "call", "name": "browser_tool", "arguments": {}}]
    if announcement == "message":
        calls.append({"toolCallId": "backend", "name": "lookup", "arguments": {}})
    session.emit("assistant.message", messageId="m", content="", toolRequests=calls)
    if announcement == "arguments":
        session.emit(
            "assistant.tool_call_delta", toolCallId="backend", toolName="lookup", inputDelta="{}",
        )
    session.emit(
        "external_tool.requested", toolCallId="call", toolName="browser_tool",
        requestId="rpc:call", sessionId=session.session_id,
    )
    draining = asyncio.create_task(_remaining(stream))
    try:
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(asyncio.shield(draining), 0.025)
        session.emit("tool.execution_start", toolCallId="backend", toolName="lookup", arguments={})
        agent.threads["thread"].emit(
            StateDeltaEvent(delta=[{"op": "add", "path": "/finished", "value": True}])
        )
        session.emit(
            "tool.execution_complete", toolCallId="backend", success=True,
            result={"content": "Backend finished before handoff"},
        )
        events = await draining
        assert "STATE_DELTA" in types(events)
        assert [event.content for event in events if event.type.value == "TOOL_CALL_RESULT"] == [
            "Backend finished before handoff"
        ]
        assert types(events)[-1] == "RUN_FINISHED"
    finally:
        draining.cancel()
        await asyncio.gather(draining, return_exceptions=True)
        await stream.aclose()


async def _remaining(stream):
    return [event async for event in stream]


async def test_pending_rpc_batch_commits_only_after_all_settle(factory):
    agent, client = factory("parallel")
    await collect(agent, request(tools=frontend()))
    thread, session = agent.threads["thread"], client.sessions[0]
    waiting, release = asyncio.Event(), asyncio.Event()

    async def rpc(value):
        if value.request_id == "rpc:call":
            return SimpleNamespace(success=True)
        waiting.set()
        await release.wait()
        raise RuntimeError("Second original RPC failed")

    session.rpc.tools.handle_pending_tool_call = rpc
    task = asyncio.create_task(collect(
        agent, request(tools=frontend(), messages=[result(), result("call2", identity="r2")])
    ))
    try:
        await waiting.wait()
        assert not thread.resolved
        assert set(thread.pending) == {"call", "call2"}
        release.set()
        assert types(await task)[-1] == "RUN_ERROR"
        assert not thread.resolved and session.disconnects == 1
    finally:
        release.set()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_pending_rpc_failure_settles_siblings_before_abort(factory):
    agent, client = factory("parallel")
    await collect(agent, request(tools=frontend()))
    session = client.sessions[0]
    waiting = asyncio.Event()
    order = []
    abort = session.abort

    async def rpc(value):
        if value.request_id == "rpc:call":
            await waiting.wait()
            raise RuntimeError("First RPC failed")
        waiting.set()
        try:
            await asyncio.Event().wait()
        finally:
            order.append("sibling settled")

    async def observed_abort():
        order.append("abort")
        await abort()

    session.abort = observed_abort
    session.rpc.tools.handle_pending_tool_call = rpc
    events = await collect(
        agent, request(tools=frontend(), messages=[result(), result("call2", identity="r2")])
    )
    assert types(events)[-1] == "RUN_ERROR"
    assert order == ["sibling settled", "abort"]


async def test_external_cancel_settles_rpc_before_teardown_or_commit(factory):
    agent, client = factory("frontend")
    await collect(agent, request(tools=frontend()))
    thread, session = agent.threads["thread"], client.sessions[0]
    waiting, cancelling, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    order = []
    abort = session.abort

    async def rpc(_):
        waiting.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelling.set()
            await release.wait()
            return SimpleNamespace(success=True)
        finally:
            order.append("rpc settled")

    async def observed_abort():
        order.append("abort")
        await abort()

    session.abort = observed_abort
    session.rpc.tools.handle_pending_tool_call = rpc
    task = asyncio.create_task(collect(agent, request(tools=frontend(), messages=[result()])))
    await waiting.wait()
    cancel = asyncio.create_task(agent.cancel("thread"))
    try:
        await cancelling.wait()
        await asyncio.sleep(0)
        release.set()
        await cancel
        with pytest.raises(asyncio.CancelledError):
            await task
        assert order == ["rpc settled", "abort"]
        assert not thread.resolved
    finally:
        release.set()
        task.cancel()
        await asyncio.gather(task, cancel, return_exceptions=True)


@pytest.mark.parametrize("reclaim", ["reserve", "reap"])
@pytest.mark.parametrize("owner_cancelled", [False, True])
async def test_finished_generator_owner_is_reclaimed_without_aclose(
    factory, reclaim, owner_cancelled,
):
    agent, client = factory(idle_ttl=0.01)
    streams = []
    ready = asyncio.Event()

    async def abandon():
        stream = agent.run(request())
        streams.append(stream)
        await anext(stream)
        ready.set()
        if owner_cancelled:
            await asyncio.Event().wait()

    owner = asyncio.create_task(abandon())
    await ready.wait()
    if owner_cancelled:
        owner.cancel()
        with pytest.raises(asyncio.CancelledError):
            await owner
    else:
        await owner
    assert agent.threads["thread"].owner_task is owner
    try:
        if reclaim == "reserve":
            assert types(await collect(agent, request()))[-1] == "RUN_FINISHED"
        else:
            async with asyncio.timeout(1):
                while "thread" in agent.threads:
                    await asyncio.sleep(0.005)
        assert client.sessions[0].disconnects == 1
        assert not client.sessions[0].handlers
    finally:
        await streams[0].aclose()


async def test_warm_session_gets_new_dedup_budgets_without_conversation_reset(factory):
    agent, client = factory(max_events=4, max_session_items=16)
    for index in range(6):
        events = await collect(agent, request(messages=[
            {"id": f"user-{index}", "role": "user", "content": f"turn {index}"}
        ]))
        assert types(events)[-1] == "RUN_FINISHED"
        assert len(agent.threads["thread"].mapper.seen) == 3
    assert len(client.sessions) == 1
    assert len(client.sessions[0].sends) == 6


async def test_entity_exhaustion_fails_explicitly_without_replacing_the_session(factory):
    agent, client = factory(max_session_items=1)
    assert types(await collect(agent, request()))[-1] == "RUN_FINISHED"
    events = await collect(agent, request(messages=[
        {"id": "second", "role": "user", "content": "another turn"}
    ]))
    assert types(events)[-1] == "RUN_ERROR"
    assert "RUN_FINISHED" not in types(events)
    assert len(client.sessions) == 1 and client.sessions[0].disconnects == 1
