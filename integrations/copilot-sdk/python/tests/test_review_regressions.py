"""Deterministic regressions for the bounded native-lifecycle review."""

import asyncio
import socket
from types import SimpleNamespace

import httpx
import pytest
import uvicorn
from ag_ui.core import StateSnapshotEvent
from test_agent import FakeClient, collect, frontend, request, result, types

from ag_ui_copilot_sdk import CopilotAgent, EventMapper
from ag_ui_copilot_sdk.agent import ThreadConflict
from ag_ui_copilot_sdk.server import create_app


async def test_f1_event_dedup_budget_is_not_exhausted_across_small_turns():
    class BurstClient(FakeClient):
        async def create_session(self, **options):
            session = await super().create_session(**options)

            async def send(prompt):
                session.sends.append(prompt)
                identity = f"message-{len(session.sends)}"
                for _ in range(100):
                    session.emit("assistant.message_delta", messageId=identity, deltaContent="x")
                session.emit("assistant.message", messageId=identity, content="x" * 100)
                session.emit("session.idle")

            session.send = send
            return session

    client = BurstClient()
    agent = CopilotAgent(client, max_session_items=180)
    try:
        for turn in range(2):
            events = await collect(agent, request(messages=[
                {"id": f"user-{turn}", "role": "user", "content": "hello"},
            ]))
            assert types(events)[-1] == "RUN_FINISHED"
            assert "".join(getattr(event, "delta", "") for event in events) == "x" * 100
        assert len(client.sessions) == 1
    finally:
        await agent.close()


async def test_f2_late_final_text_after_handoff_is_not_silently_lost():
    class LateClient(FakeClient):
        async def create_session(self, **options):
            session = await super().create_session(**options)
            original = session.send

            async def send(prompt):
                session.emit("assistant.message_delta", messageId="late", deltaContent="Before ")
                await original(prompt)

            session.send = send
            return session

    client = LateClient("frontend")
    agent = CopilotAgent(client, handoff_delay=0.005)
    try:
        first = await collect(agent, request(tools=frontend()))
        assert types(first)[-1] == "RUN_FINISHED"
        client.sessions[0].emit("assistant.message", messageId="late", content="Before late-suffix")
        second = await collect(agent, request(tools=frontend(), messages=[result()]))
        # A snapshot correction or a new valid text segment may retain the suffix.
        assert any("late-suffix" in event.model_dump_json(by_alias=True) for event in second)
        assert "".join(
            event.delta for event in first + second if event.type.value == "TEXT_MESSAGE_CONTENT"
        ) == (
            "Before late-suffixOriginal consumed nonce"
        )
        original = next(event.message_id for event in first if event.type.value == "TEXT_MESSAGE_START")
        resumed = next(event.message_id for event in second if event.type.value == "TEXT_MESSAGE_START")
        assert original != resumed, "A closed AG-UI text segment must not reopen under the same ID"
        assert not any(
            event.type.value == "TOOL_CALL_RESULT" and event.tool_call_id == "call"
            for event in second
        )
    finally:
        await agent.close()


async def test_f3_failed_pending_rpc_settles_siblings_before_disconnect():
    client = FakeClient("parallel")
    agent = CopilotAgent(client, handoff_delay=0.005, run_timeout=1)
    started, settled, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    disconnected_after_settled = []
    try:
        await collect(agent, request(tools=frontend()))
        session = client.sessions[0]
        original_disconnect = session.disconnect

        async def resolve(value):
            if value.request_id == "rpc:call":
                await started.wait()
                raise RuntimeError("deterministic RPC failure")
            started.set()
            try:
                await release.wait()
                return SimpleNamespace(success=True)
            finally:
                settled.set()

        async def disconnect():
            disconnected_after_settled.append(settled.is_set())
            await original_disconnect()

        session.rpc.tools.handle_pending_tool_call = resolve
        session.disconnect = disconnect
        events = await collect(agent, request(tools=frontend(), messages=[
            result(), result("call2", identity="second"),
        ]))
        assert types(events)[-1] == "RUN_ERROR"
        assert disconnected_after_settled == [True]
    finally:
        release.set()
        await asyncio.sleep(0)
        await agent.close()


async def test_f2_late_backend_completion_survives_frontend_handoff():
    client = FakeClient("frontend")
    agent = CopilotAgent(client, handoff_delay=0.005)
    try:
        await collect(agent, request(tools=frontend()))
        session = client.sessions[0]
        session.emit("tool.execution_start", toolCallId="late-backend", toolName="lookup", arguments={})
        session.emit(
            "tool.execution_complete", toolCallId="late-backend",
            success=True, result={"content": "late-backend-result"},
        )
        events = await collect(agent, request(tools=frontend(), messages=[result()]))
        assert types(events)[-1] == "RUN_FINISHED"
        assert any(
            event.type.value == "TOOL_CALL_RESULT" and event.tool_call_id == "late-backend"
            and event.content == "late-backend-result" for event in events
        )
    finally:
        await agent.close()


async def test_f2_late_host_state_is_not_overwritten_by_stale_continuation_state():
    client = FakeClient("frontend")
    agent = CopilotAgent(client, handoff_delay=0.005)
    try:
        await collect(agent, request(tools=frontend(), state={"version": 0}))
        thread = agent.threads["thread"]
        thread.state = {"version": 1}
        thread.emit(StateSnapshotEvent(snapshot=thread.state))
        events = await collect(agent, request(
            tools=frontend(), messages=[result()], state={"version": 0},
        ))
        assert types(events)[-1] == "RUN_FINISHED"
        snapshots = [event.snapshot for event in events if event.type.value == "STATE_SNAPSHOT"]
        assert snapshots[-1] == {"version": 1}
        assert thread.state == {"version": 1}, "Browser continuation must not undo a late host update"
    finally:
        await agent.close()


async def test_f2_conflicting_late_state_preserves_pending_ownership_for_retry():
    client = FakeClient("frontend")
    agent = CopilotAgent(client, handoff_delay=0.005)
    try:
        await collect(agent, request(tools=frontend(), state={"version": 0}))
        thread = agent.threads["thread"]
        thread.state = {"version": 1}
        thread.emit(StateSnapshotEvent(snapshot=thread.state))
        pending = dict(thread.pending)
        with pytest.raises(ThreadConflict, match="State changed"):
            await collect(agent, request(
                tools=frontend(), messages=[result()], state={"version": 2},
            ))
        assert thread.pending == pending
        assert thread.state == {"version": 1}
        assert client.sessions[0].disconnects == 0
        events = await collect(agent, request(
            tools=frontend(), messages=[result()], state={"version": 0},
        ))
        assert types(events)[-1] == "RUN_FINISHED"
        assert thread.state == {"version": 1}
        assert len(client.sessions[0].sends) == 1
    finally:
        await agent.close()


def test_f4_unknown_agent_cannot_emit_an_unannounced_child_stream():
    mapper = EventMapper()
    try:
        events = mapper.map_event({
            "id": "unannounced", "type": "assistant.message_delta", "agentId": "unknown-child",
            "data": {"messageId": "message", "deltaContent": "child content"},
        })
    except ValueError:
        return  # Explicit rejection is safe; silently dropping ancestry is not.
    assert events == [], "Buffer until an authoritative child start, or reject explicitly"


async def test_f5_cancelled_owner_without_aclose_does_not_pin_thread():
    client = FakeClient()
    agent = CopilotAgent(client)
    stream = agent.run(request())
    paused = asyncio.Event()

    async def abandoned_consumer():
        await anext(stream)
        paused.set()
        await asyncio.Event().wait()

    owner = asyncio.create_task(abandoned_consumer())
    try:
        await asyncio.wait_for(paused.wait(), 1)
        owner.cancel()
        with pytest.raises(asyncio.CancelledError):
            await owner
        events = await collect(agent, request(messages=[
            {"id": "next", "role": "user", "content": "new turn"},
        ]))
        assert types(events)[-1] == "RUN_FINISHED"
        assert client.sessions[0].disconnects == 1
        assert len(client.sessions) == 2
    finally:
        owner.cancel()
        await asyncio.gather(owner, return_exceptions=True)
        await stream.aclose()
        await agent.close()


async def test_f5_real_http_disconnect_allows_same_thread_reuse():
    client = FakeClient("hang")
    agent = CopilotAgent(client)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    port = listener.getsockname()[1]
    host = uvicorn.Server(uvicorn.Config(create_app(agent), log_level="error", lifespan="on"))
    serving = asyncio.create_task(host.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(3):
            while not host.started:
                await asyncio.sleep(0.005)
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=3) as http:
            async with http.stream("POST", "/agent", json=request()) as response:
                assert response.status_code == 200
                assert "RUN_STARTED" in await anext(response.aiter_lines())
            async with asyncio.timeout(3):
                while "thread" in agent.threads:
                    await asyncio.sleep(0.005)
            assert client.sessions[0].disconnects == 1
            client.scenario = "text"
            response = await http.post("/agent", json=request(messages=[
                {"id": "after-disconnect", "role": "user", "content": "new turn"},
            ]))
            assert response.status_code == 200
            assert '"RUN_FINISHED"' in response.text
            assert len(client.sessions) == 2
    finally:
        host.should_exit = True
        try:
            await asyncio.wait_for(serving, 3)
        finally:
            listener.close()
            await agent.close()
