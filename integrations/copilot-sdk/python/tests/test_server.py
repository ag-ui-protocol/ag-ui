"""The distributable server does not depend on the sibling example repository."""

import json
import runpy
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from ag_ui.core import RunFinishedEvent, RunStartedEvent

from ag_ui_copilot_sdk import CopilotAgent, EventMapper, server
from ag_ui_copilot_sdk.fixture import GREETING_CHUNKS, FixtureClient


class Adapter:
    closed = False
    cancelled = None

    async def run(self, value):
        yield RunStartedEvent(thread_id=value.thread_id, run_id=value.run_id)
        yield RunFinishedEvent(thread_id=value.thread_id, run_id=value.run_id)

    async def cancel(self, thread_id):
        self.cancelled = thread_id

    async def close(self):
        self.closed = True


async def test_self_contained_server_routes_and_shutdown():
    adapter = Adapter()
    app = server.create_app(adapter)
    async with app.router.lifespan_context(app), httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://127.0.0.1"
    ) as client:
        assert (await client.get("/health")).json()["sdk"] == "1.0.14"
        response = await client.post(
            "/agent",
            json={
                "threadId": "t",
                "runId": "r",
                "state": {},
                "messages": [{"id": "u", "role": "user", "content": "hello"}],
                "tools": [],
                "context": [],
                "forwardedProps": {},
            },
        )
        assert response.status_code == 200
        events = [
            json.loads(line[5:])
            for line in response.text.splitlines()
            if line.startswith("data:")
        ]
        assert [event["type"] for event in events] == ["RUN_STARTED", "RUN_FINISHED"]
        assert (await client.post("/cancel", json={"threadId": "t"})).status_code == 200
        assert adapter.cancelled == "t"
        assert (await client.post("/agent", json={})).status_code == 422
    assert adapter.closed


def test_server_host_port_environment(monkeypatch):
    calls = []
    monkeypatch.setitem(
        sys.modules, "uvicorn", SimpleNamespace(run=lambda *args, **kwargs: calls.append(kwargs))
    )
    monkeypatch.delenv("HOST", raising=False)
    monkeypatch.delenv("PORT", raising=False)
    server.run_server()
    assert calls[-1]["host"] == "127.0.0.1" and calls[-1]["port"] == 8123
    monkeypatch.setenv("HOST", "localhost")
    monkeypatch.setenv("PORT", "8125")
    server.run_server()
    assert calls[-1]["host"] == "localhost" and calls[-1]["port"] == 8125
    for host in ("0.0.0.0", "::1"):
        monkeypatch.setenv("HOST", host)
        server.run_server()
        assert calls[-1]["host"] == host
    for host in ("", "https://example.org"):
        monkeypatch.setenv("HOST", host)
        with pytest.raises(ValueError):
            server.run_server()
    monkeypatch.setenv("HOST", "127.0.0.1")
    monkeypatch.setenv("PORT", "0")
    with pytest.raises(ValueError):
        server.run_server()


async def test_native_startup_failure_still_stops_owned_client(monkeypatch):
    monkeypatch.delenv("COPILOT_DEMO_MODE", raising=False)

    class FailedClient:
        stopped = False

        async def start(self):
            raise RuntimeError("startup failed")

        async def stop(self):
            self.stopped = True

    client = FailedClient()
    monkeypatch.setattr(server, "CopilotClient", lambda **kwargs: client)
    app = server.create_app()
    with pytest.raises(RuntimeError, match="startup failed"):
        async with app.router.lifespan_context(app):
            raise AssertionError("startup unexpectedly succeeded")
    assert client.stopped


@pytest.mark.parametrize("override,expected", [(None, "auto"), ("claude-sonnet-5", "claude-sonnet-5")])
async def test_private_runtime_cleanup_and_model_override(monkeypatch, tmp_path, override, expected):
    monkeypatch.setenv("COPILOT_DEMO_MODE", "live")
    if override is None:
        monkeypatch.delenv("COPILOT_MODEL", raising=False)
    else:
        monkeypatch.setenv("COPILOT_MODEL", override)
    untouched = tmp_path / "host-owned"
    untouched.write_text("keep")
    captured = {}

    def factory(**options):
        captured.update(options)
        return FixtureClient()

    app = server.create_app(client_factory=factory, storage_directory=tmp_path)
    async with app.router.lifespan_context(app):
        runtime = Path(captured["base_directory"])
        assert runtime.parent == tmp_path
        assert runtime.stat().st_mode & 0o777 == 0o700
        assert captured["mode"] == "empty"
        assert app.state.adapter.model == expected
        (runtime / "fixture-data").write_text("owned")
    assert not runtime.exists()
    assert untouched.read_text() == "keep"


async def test_fixture_mode_is_explicit_offline_and_uses_real_adapter_mapper(monkeypatch):
    monkeypatch.setenv("COPILOT_DEMO_MODE", "fixture")

    def forbidden_native_client(**kwargs):
        raise AssertionError("Fixture mode must never construct a native runtime/auth client")

    monkeypatch.setattr(server, "CopilotClient", forbidden_native_client)
    app = server.create_app()
    async with app.router.lifespan_context(app):
        assert isinstance(app.state.adapter, CopilotAgent)
        assert isinstance(app.state.adapter.client, FixtureClient)
        fixture = app.state.adapter.client
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://127.0.0.1"
        ) as client:
            health = (await client.get("/health")).json()
            assert health["mode"] == "fixture" and health["synthetic"] is True
            response = await client.post(
                "/agent",
                json={
                    "threadId": "offline",
                    "runId": "run",
                    "state": {},
                    "messages": [{"id": "u", "role": "user", "content": "hello"}],
                    "tools": [],
                    "context": [],
                    "forwardedProps": {},
                },
            )
            events = [
                json.loads(line[5:])
                for line in response.text.splitlines()
                if line.startswith("data:")
            ]
            assert [event["type"] for event in events] == [
                "RUN_STARTED",
                "STATE_SNAPSHOT",
                "TEXT_MESSAGE_START",
                "TEXT_MESSAGE_CONTENT",
                "TEXT_MESSAGE_CONTENT",
                "TEXT_MESSAGE_CONTENT",
                "TEXT_MESSAGE_END",
                "RUN_FINISHED",
            ]
            assert "".join(
                event["delta"] for event in events if event["type"] == "TEXT_MESSAGE_CONTENT"
            ) == "".join(GREETING_CHUNKS)
            assert isinstance(app.state.adapter.threads["offline"].mapper, EventMapper)
            session = fixture.sessions[0]
            assert session.handlers
            await client.post("/cancel", json={"threadId": "offline"})
            assert session.closed and not session.handlers and session.task is None
    assert not fixture.started and not fixture.sessions


async def test_fixture_deltas_arrive_incrementally_and_abort_cleans_tasks():
    client = FixtureClient()
    await client.start()
    agent = CopilotAgent(client)
    stream = agent.run(
        {
            "threadId": "offline",
            "runId": "run",
            "state": {},
            "messages": [{"id": "u", "role": "user", "content": "hello"}],
            "tools": [],
            "context": [],
            "forwardedProps": {},
        }
    )
    try:
        while (event := await anext(stream)).type.value != "TEXT_MESSAGE_CONTENT":
            pass
        assert event.delta == GREETING_CHUNKS[0]
        session = client.sessions[0]
        assert session.task is not None and not session.task.done()
        await stream.aclose()
        assert session.task is None and session.closed and not session.handlers
    finally:
        await agent.close()
        await client.stop()


def test_invalid_demo_mode_cannot_silently_fall_back_to_live(monkeypatch):
    monkeypatch.setenv("COPILOT_DEMO_MODE", "typo")
    with pytest.raises(ValueError, match="COPILOT_DEMO_MODE"):
        server.create_app()


def test_dojo_entrypoint_and_one_sentence_hello_fixture(monkeypatch):
    calls = []
    monkeypatch.setattr(server, "main", lambda: calls.append(True))
    example = Path(__file__).resolve().parents[1] / "examples" / "server.py"
    runpy.run_path(str(example), run_name="__main__")
    assert calls == [True]
    greeting = "".join(GREETING_CHUNKS)
    assert "hello" in greeting and "synthetic" in greeting
    assert greeting.count(".") == 1
