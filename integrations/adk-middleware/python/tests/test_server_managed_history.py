"""Server-managed history: capability advertisement and history cursor checks.

Prototype for ag-ui-protocol/ag-ui#2186. With ``server_managed_history=True``
the client uploads only unconfirmed messages and names its last confirmed
message in ``forwardedProps["ag-ui:historyCursor"]``. A cursor the server
cannot vouch for must end the run with ``HISTORY_UNAVAILABLE`` before anything
is mutated, so the client's full-history retry starts from a clean thread.
"""

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ag_ui.core import EventType, RunAgentInput
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
from ag_ui_adk.adk_agent import HISTORY_CURSOR_PROP
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import InMemorySessionService
from google.genai import types

APP = "smh"
USER = "user"


class RecordingModel(BaseLlm):
    """Answers every turn and records how many contents the model was given."""

    model: str = "server-managed-history-test"
    context_sizes: list = []

    async def generate_content_async(self, llm_request, stream=False):
        self.context_sizes.append(len(llm_request.contents))
        yield LlmResponse(
            content=types.Content(
                role="model",
                parts=[types.Part(text=f"reply {len(self.context_sizes)}")],
            ),
            partial=False,
            turn_complete=True,
        )


@pytest.fixture(autouse=True)
def reset_session_manager():
    SessionManager.reset_instance()
    yield
    SessionManager.reset_instance()


def _agent(model, service, **kwargs):
    return ADKAgent(
        adk_agent=LlmAgent(name="assistant", model=model),
        app_name=APP,
        user_id=USER,
        session_service=service,
        **kwargs,
    )


def _input(thread_id, run_id, messages, cursor=None, forwarded_props=None):
    props = dict(forwarded_props or {})
    if cursor is not None:
        props[HISTORY_CURSOR_PROP] = cursor
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        state={},
        messages=messages,
        tools=[],
        context=[],
        forwarded_props=props,
    )


def _user(message_id, text):
    return {"id": message_id, "role": "user", "content": text}


async def _run(agent, run_input):
    return [event async for event in agent.run(run_input)]


def _assistant_text_id(events):
    return next(e.message_id for e in events if e.type == EventType.TEXT_MESSAGE_START)


async def _session_events(service, thread_id):
    listed = await service.list_sessions(app_name=APP, user_id=USER)
    for summary in listed.sessions:
        session = await service.get_session(
            app_name=APP, user_id=USER, session_id=summary.id
        )
        if session.state.get("_ag_ui_thread_id") == thread_id:
            return list(session.events)
    return None


class TestCapabilities:
    def test_default_leaves_capabilities_untouched(self):
        assert _agent(RecordingModel(), InMemorySessionService()).get_capabilities() is None
        caps = {"custom": {"predictiveChips": True}}
        agent = _agent(RecordingModel(), InMemorySessionService(), capabilities=caps)
        assert agent.get_capabilities() == {"custom": {"predictiveChips": True}}

    def test_flag_without_capabilities_advertises_custom_flag(self):
        agent = _agent(
            RecordingModel(), InMemorySessionService(), server_managed_history=True
        )
        assert agent.get_capabilities() == {"custom": {"serverManagedHistory": True}}

    def test_flag_merges_with_configured_capabilities(self):
        caps = {
            "identity": {"name": "assistant"},
            "custom": {"predictiveChips": True},
        }
        agent = _agent(
            RecordingModel(),
            InMemorySessionService(),
            capabilities=caps,
            server_managed_history=True,
        )
        assert agent.get_capabilities() == {
            "identity": {"name": "assistant"},
            "custom": {"predictiveChips": True, "serverManagedHistory": True},
        }
        # The caller's dict is not mutated by the merge.
        assert caps["custom"] == {"predictiveChips": True}

    def test_flag_accepts_null_custom(self):
        agent = _agent(
            RecordingModel(),
            InMemorySessionService(),
            capabilities={"custom": None},
            server_managed_history=True,
        )
        assert agent.get_capabilities() == {"custom": {"serverManagedHistory": True}}

    def test_flag_rejects_non_dict_custom(self):
        with pytest.raises(ValueError, match="custom"):
            _agent(
                RecordingModel(),
                InMemorySessionService(),
                capabilities={"custom": ["not", "a", "dict"]},
                server_managed_history=True,
            )

    def test_from_app_forwards_flag(self):
        from google.adk.apps import App

        app = App(name=APP, root_agent=LlmAgent(name="assistant", model=RecordingModel()))
        agent = ADKAgent.from_app(app, user_id=USER, server_managed_history=True)
        assert agent.get_capabilities() == {"custom": {"serverManagedHistory": True}}

    @pytest.mark.parametrize("enabled", [False, True])
    def test_capabilities_endpoint(self, enabled):
        app = FastAPI()
        agent = _agent(
            RecordingModel(),
            InMemorySessionService(),
            capabilities={"custom": {"predictiveChips": True}},
            server_managed_history=enabled,
        )
        add_adk_fastapi_endpoint(app, agent, path="/chat")
        body = TestClient(app).get("/chat/capabilities").json()
        assert body["custom"]["predictiveChips"] is True
        assert ("serverManagedHistory" in body["custom"]) is enabled


class TestHistoryCursor:
    async def test_unknown_thread_with_cursor_is_unavailable(self):
        model = RecordingModel(context_sizes=[])
        service = InMemorySessionService()
        agent = _agent(model, service, server_managed_history=True)

        events = await _run(
            agent, _input("new-thread", "r1", [_user("u2", "hi")], cursor="m1")
        )

        assert [e.type for e in events] == [EventType.RUN_ERROR]
        assert events[0].code == "HISTORY_UNAVAILABLE"
        assert model.context_sizes == []
        # Rejection happens before any session is created.
        assert await _session_events(service, "new-thread") is None

    async def test_delta_upload_with_known_cursor_uses_server_context(self):
        model = RecordingModel(context_sizes=[])
        service = InMemorySessionService()
        agent = _agent(model, service, server_managed_history=True)

        first = await _run(agent, _input("t", "r1", [_user("u1", "first")]))
        assert first[-1].type == EventType.RUN_FINISHED
        cursor = _assistant_text_id(first)

        second = await _run(
            agent, _input("t", "r2", [_user("u2", "second")], cursor=cursor)
        )

        assert second[-1].type == EventType.RUN_FINISHED, second
        # The model saw the stored first turn plus the new message, although
        # the client uploaded only the new message.
        assert model.context_sizes == [1, 3]

    async def test_user_message_id_is_a_valid_cursor(self):
        model = RecordingModel(context_sizes=[])
        agent = _agent(model, InMemorySessionService(), server_managed_history=True)
        await _run(agent, _input("t", "r1", [_user("u1", "first")]))

        events = await _run(agent, _input("t", "r2", [_user("u2", "next")], cursor="u1"))

        assert events[-1].type == EventType.RUN_FINISHED

    async def test_unknown_cursor_on_known_thread_mutates_nothing(self):
        model = RecordingModel(context_sizes=[])
        service = InMemorySessionService()
        agent = _agent(model, service, server_managed_history=True)
        await _run(agent, _input("t", "r1", [_user("u1", "first")]))
        before = await _session_events(service, "t")

        events = await _run(
            agent, _input("t", "r2", [_user("u2", "second")], cursor="forged")
        )

        assert [e.type for e in events] == [EventType.RUN_ERROR]
        assert events[0].code == "HISTORY_UNAVAILABLE"
        assert model.context_sizes == [1]
        assert len(await _session_events(service, "t")) == len(before)

        # The full-history retry without a cursor dedupes what is stored.
        retry = await _run(
            agent,
            _input("t", "r3", [_user("u1", "first"), _user("u2", "second")]),
        )
        assert retry[-1].type == EventType.RUN_FINISHED
        assert model.context_sizes == [1, 3]

    @pytest.mark.parametrize("cursor", ["", 42, ["u1"]])
    async def test_malformed_cursor_is_unavailable(self, cursor):
        agent = _agent(
            RecordingModel(context_sizes=[]),
            InMemorySessionService(),
            server_managed_history=True,
        )
        await _run(agent, _input("t", "r1", [_user("u1", "first")]))

        events = await _run(agent, _input("t", "r2", [_user("u2", "x")], cursor=cursor))

        assert events[0].type == EventType.RUN_ERROR
        assert events[0].code == "HISTORY_UNAVAILABLE"

    async def test_null_cursor_means_no_cursor(self):
        agent = _agent(
            RecordingModel(context_sizes=[]),
            InMemorySessionService(),
            server_managed_history=True,
        )
        events = await _run(
            agent,
            _input("t", "r1", [_user("u1", "x")], forwarded_props={HISTORY_CURSOR_PROP: None}),
        )
        assert events[-1].type == EventType.RUN_FINISHED

    async def test_flag_off_ignores_cursor(self):
        model = RecordingModel(context_sizes=[])
        agent = _agent(model, InMemorySessionService())

        events = await _run(
            agent, _input("fresh", "r1", [_user("u1", "hi")], cursor="unknown")
        )

        assert events[-1].type == EventType.RUN_FINISHED
        assert model.context_sizes == [1]

    async def test_cursors_survive_a_restart(self):
        """A new process verifies cursors from the durable ledger and events."""
        service = InMemorySessionService()
        model = RecordingModel(context_sizes=[])
        agent = _agent(model, service, server_managed_history=True)
        first = await _run(agent, _input("t", "r1", [_user("u1", "first")]))
        assistant_1 = _assistant_text_id(first)
        await _run(agent, _input("t", "r2", [_user("u2", "second")], cursor=assistant_1))
        # The last event that becomes a message (state-only events do not).
        event_id = [
            e for e in await _session_events(service, "t") if e.content is not None
        ][-1].id

        SessionManager.reset_instance()
        restarted = _agent(model, service, server_managed_history=True)
        for run_id, cursor in (("r3", "u2"), ("r4", assistant_1), ("r5", event_id)):
            events = await _run(
                restarted,
                _input("t", run_id, [_user(f"m-{run_id}", "more")], cursor=cursor),
            )
            assert events[-1].type == EventType.RUN_FINISHED, (cursor, events)

    async def test_latest_reply_is_a_cursor_on_another_instance(self):
        """Reply ids are persisted when the run finishes, not on the next run."""
        service = InMemorySessionService()
        model = RecordingModel(context_sizes=[])
        agent = _agent(model, service, server_managed_history=True)
        first = await _run(agent, _input("t", "r1", [_user("u1", "first")]))

        SessionManager.reset_instance()
        replica = _agent(model, service, server_managed_history=True)
        events = await _run(
            replica,
            _input("t", "r2", [_user("u2", "second")], cursor=_assistant_text_id(first)),
        )

        assert events[-1].type == EventType.RUN_FINISHED, events
        assert model.context_sizes == [1, 3]

    async def test_deleted_session_is_unavailable_despite_cached_ledger(self):
        service = InMemorySessionService()
        model = RecordingModel(context_sizes=[])
        agent = _agent(model, service, server_managed_history=True)
        await _run(agent, _input("t", "r1", [_user("u1", "first")]))
        session_id = (await service.list_sessions(app_name=APP, user_id=USER)).sessions[0].id
        await service.delete_session(app_name=APP, user_id=USER, session_id=session_id)

        events = await _run(agent, _input("t", "r2", [_user("u2", "second")], cursor="u1"))

        assert [e.type for e in events] == [EventType.RUN_ERROR]
        assert events[0].code == "HISTORY_UNAVAILABLE"
        assert model.context_sizes == [1]

    async def test_confirmed_ids_are_written_once_per_run(self):
        """The ledger write happens once, at RUN_FINISHED, not per streamed event."""
        from ag_ui_adk.session_manager import PROCESSED_MESSAGE_ID_STATE_PREFIX

        class ChunkedModel(RecordingModel):
            async def generate_content_async(self, llm_request, stream=False):
                self.context_sizes.append(len(llm_request.contents))
                for chunk in ("one ", "two ", "three"):
                    yield LlmResponse(
                        content=types.Content(role="model", parts=[types.Part(text=chunk)]),
                        partial=True,
                    )
                yield LlmResponse(
                    content=types.Content(
                        role="model", parts=[types.Part(text="one two three")]
                    ),
                    partial=False,
                    turn_complete=True,
                )

        service = InMemorySessionService()
        agent = _agent(ChunkedModel(context_sizes=[]), service, server_managed_history=True)
        manager = agent._session_manager
        ledger_writes = []
        original_update = manager.update_session_state

        async def counting_update(session_id, app_name, user_id, state_updates, *args, **kwargs):
            if any(key.startswith(PROCESSED_MESSAGE_ID_STATE_PREFIX) for key in state_updates):
                ledger_writes.append(dict(state_updates))
            return await original_update(
                session_id, app_name, user_id, state_updates, *args, **kwargs
            )

        manager.update_session_state = counting_update

        events = await _run(agent, _input("t", "r1", [_user("u1", "first")]))

        assert events[-1].type == EventType.RUN_FINISHED
        assert len([e for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT]) > 1
        assert len(ledger_writes) == 1, ledger_writes
        assert (
            PROCESSED_MESSAGE_ID_STATE_PREFIX + _assistant_text_id(events)
            in ledger_writes[0]
        )

    async def test_failed_run_reply_is_not_a_cursor(self):
        class FailingAfterText(RecordingModel):
            async def generate_content_async(self, llm_request, stream=False):
                yield LlmResponse(
                    content=types.Content(role="model", parts=[types.Part(text="partial")]),
                    partial=True,
                )
                raise RuntimeError("synthetic provider failure")

        service = InMemorySessionService()
        agent = _agent(FailingAfterText(context_sizes=[]), service, server_managed_history=True)
        events = await _run(agent, _input("t", "r1", [_user("u1", "first")]))
        assert events[-1].type == EventType.RUN_ERROR
        started = [e for e in events if e.type == EventType.TEXT_MESSAGE_START]
        assert started

        for event in started:
            rejection = await agent._check_history_cursor(
                _input("t", "r2", [], cursor=event.message_id), USER, app_name=APP
            )
            assert rejection is not None and rejection.code == "HISTORY_UNAVAILABLE"

    async def test_reasoning_suffix_only_for_thought_events(self):
        service = InMemorySessionService()
        agent = _agent(RecordingModel(context_sizes=[]), service, server_managed_history=True)
        await _run(agent, _input("t", "r1", [_user("u1", "first")]))
        event_id = [
            e for e in await _session_events(service, "t") if e.content is not None
        ][-1].id

        rejection = await agent._check_history_cursor(
            _input("t", "r2", [], cursor=f"{event_id}-reasoning"), USER, app_name=APP
        )

        assert rejection is not None and rejection.code == "HISTORY_UNAVAILABLE"

    async def test_tool_call_id_cursor_is_accepted(self):
        """``@ag-ui/client`` names a tool-call-only assistant message by call id."""
        service = InMemorySessionService()
        agent = _agent(RecordingModel(context_sizes=[]), service, server_managed_history=True)
        await _run(agent, _input("t", "r1", [_user("u1", "first")]))
        events = await _session_events(service, "t")
        assert events
        session_id = (await service.list_sessions(app_name=APP, user_id=USER)).sessions[0].id
        session = await service.get_session(app_name=APP, user_id=USER, session_id=session_id)
        from google.adk.events import Event

        await service.append_event(
            session,
            Event(
                author="assistant",
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                id="call-1", name="lookup", args={}
                            )
                        )
                    ],
                ),
            ),
        )

        rejection = await agent._check_history_cursor(
            _input("t", "r2", [], cursor="call-1"), USER, app_name=APP
        )

        assert rejection is None


class TestEndpoint:
    def test_unknown_cursor_over_http(self):
        app = FastAPI()
        agent = _agent(
            RecordingModel(context_sizes=[]),
            InMemorySessionService(),
            server_managed_history=True,
        )
        add_adk_fastapi_endpoint(app, agent, path="/chat")
        payload = {
            "threadId": "unknown",
            "runId": "r1",
            "state": {},
            "messages": [{"id": "u2", "role": "user", "content": "hi"}],
            "tools": [],
            "context": [],
            "forwardedProps": {HISTORY_CURSOR_PROP: "m1"},
        }

        response = TestClient(app).post(
            "/chat", json=payload, headers={"accept": "text/event-stream"}
        )

        data = [
            json.loads(line[len("data:"):])
            for line in response.text.splitlines()
            if line.startswith("data:")
        ]
        assert [d["type"] for d in data] == ["RUN_ERROR"]
        assert data[0]["code"] == "HISTORY_UNAVAILABLE"
