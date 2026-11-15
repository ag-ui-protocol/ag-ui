import asyncio
from types import SimpleNamespace

from ag_ui_claude_managed_agents import SessionBinding, InMemorySessionStore
from .fake_client import FakeClient
from .test_agent import base_input, new_agent


async def collect(agent, value):
    return [event async for event in agent.run(value)]


def call(id, kind="agent.tool_use", **kwargs):
    return {
        "id": id,
        "type": kind,
        "name": "lookup",
        "input": {"q": "test"},
        "evaluated_permission": "ask",
        **kwargs,
    }


def idle(ids):
    return {
        "id": "idle",
        "type": "session.status_idle",
        "stop_reason": {"type": "requires_action", "event_ids": ids},
    }


class Page:
    def __init__(self, pages):
        self.pages = pages
        self.data = pages[0]

    def has_next_page(self):
        return len(self.pages) > 1

    async def get_next_page(self):
        return Page(self.pages[1:])


class RecoveryClient(FakeClient):
    def __init__(self, pages, **kwargs):
        super().__init__(**kwargs)
        self.pages = pages
        self.beta.sessions.events.list = self.list_history
        self.beta.sessions.threads = SimpleNamespace(
            events=SimpleNamespace(stream=self.child_stream, list=self.list_history)
        )

    async def child_stream(self, thread_id, *, session_id):
        return await self._stream(thread_id, parent=session_id)

    async def list_history(self, *args, **kwargs):
        assert self.streams_opened, "history must follow stream open"
        assert not self.sent, "history must precede responses"
        return Page(self.pages)


async def test_restart_multiple_native_and_custom_requests_and_partial_resume():
    history = [
        [
            call("a"),
            call("b", "agent.mcp_tool_use"),
            call("c", "agent.custom_tool_use"),
        ],
        [idle(["a", "b", "c"])],
    ]
    store = InMemorySessionStore()
    fake = RecoveryClient(history)
    first = new_agent(
        fake,
        store,
        resolve_session=lambda _: SessionBinding("native", last_user_message_id="u1"),
    )
    events = await collect(first, base_input())
    assert [i.id for i in events[-1].outcome.interrupts] == ["a", "b"]
    assert not fake.sent and not fake.create_calls and not fake.update_calls
    second_fake = RecoveryClient(history)
    second = new_agent(second_fake, store)
    events = await collect(
        second,
        base_input(
            resume=[{"interruptId": "a", "status": "resolved", "payload": "allow"}],
            messages=[
                {"id": "r", "role": "tool", "toolCallId": "c", "content": "done"}
            ],
        ),
    )
    assert [i.id for i in events[-1].outcome.interrupts] == ["b"]
    assert second_fake.sent[0]["events"] == [
        {"type": "user.tool_confirmation", "tool_use_id": "a", "result": "allow"},
        {
            "type": "user.custom_tool_result",
            "custom_tool_use_id": "c",
            "content": [{"type": "text", "text": "done"}],
            "is_error": False,
        },
    ]


async def test_invalid_resume_is_atomic():
    fake = RecoveryClient([[call("a"), call("b"), idle(["a", "b"])]])
    agent = new_agent(fake, resolve_session=lambda _: SessionBinding("native"))
    events = await collect(
        agent,
        base_input(
            resume=[
                {"interruptId": "a", "status": "resolved", "payload": "allow"},
                {"interruptId": "b", "status": "resolved", "payload": "yes"},
            ]
        ),
    )
    assert events[-1].code == "invalid_resume"
    assert not fake.sent


async def test_resolved_history_subtracted_and_cancel_maps_to_deny():
    fake = RecoveryClient(
        [
            [call("a"), call("b"), idle(["a", "b"])],
            [
                {
                    "id": "done",
                    "type": "user.tool_confirmation",
                    "tool_use_id": "a",
                    "result": "allow",
                }
            ],
        ],
        streams=[
            [
                {
                    "id": "end",
                    "type": "session.status_idle",
                    "stop_reason": {"type": "end_turn"},
                }
            ]
        ],
    )
    agent = new_agent(fake, resolve_session=lambda _: SessionBinding("native"))
    events = await collect(
        agent, base_input(resume=[{"interruptId": "b", "status": "cancelled"}])
    )
    assert events[-1].type.value == "RUN_FINISHED"
    assert fake.sent[0]["events"] == [
        {"type": "user.tool_confirmation", "tool_use_id": "b", "result": "deny"}
    ]


async def test_adoption_does_not_replay_history_or_execute_backend():
    fake = RecoveryClient([[call("c", "agent.custom_tool_use")]])
    agent = new_agent(fake, resolve_session=lambda _: SessionBinding("native"))
    events = await collect(agent, base_input())
    assert events[-1].type.value == "RUN_FINISHED"
    assert not fake.sent


async def test_child_followup_rejected_and_terminated_binding_retained():
    fake = RecoveryClient(
        [
            [
                {
                    "id": "idle",
                    "type": "session.thread_status_idle",
                    "stop_reason": {"type": "end_turn"},
                }
            ]
        ]
    )
    agent = new_agent(
        fake,
        resolve_session=lambda _: SessionBinding(
            "native", session_thread_id="child", last_user_message_id="u0"
        ),
    )
    events = await collect(
        agent,
        base_input(
            messages=[
                {"id": "u0", "role": "user", "content": "old"},
                {"id": "u1", "role": "user", "content": "new"},
            ]
        ),
    )
    assert events[-1].code == "unsupported_child_followup"
    assert not fake.sent
    fake = RecoveryClient([[{"id": "ended", "type": "session.status_terminated"}]])
    store = InMemorySessionStore()
    agent = new_agent(fake, store, resolve_session=lambda _: SessionBinding("native"))
    assert (await collect(agent, base_input()))[-1].code == "session_ended"
    assert (await collect(new_agent(fake, store), base_input()))[
        -1
    ].code == "session_ended"
    assert not fake.create_calls


async def test_resumed_disconnect_preserves_session():
    gate = asyncio.Event()
    fake = RecoveryClient(
        [[{"id": "running", "type": "session.status_running"}]], streams=[[gate]]
    )
    agent = new_agent(fake, resolve_session=lambda _: SessionBinding("native"))
    stream = agent.run(base_input())
    while (await anext(stream)).type.value != "CUSTOM":
        pass
    await stream.aclose()
    await asyncio.gather(*agent._tasks, return_exceptions=True)
    assert not fake.sent


async def test_disk_roundtrip_replays_missed_output_without_tool_execution(tmp_path):
    import json
    from dataclasses import asdict
    from ag_ui_claude_managed_agents import SessionRecord, BackendTool

    class DiskStore:
        def get(self, key):
            path = tmp_path / "binding.json"
            return (
                SessionRecord(**json.loads(path.read_text())) if path.exists() else None
            )

        def set(self, key, record):
            (tmp_path / "binding.json").write_text(json.dumps(asdict(record)))

        def delete(self, key):
            (tmp_path / "binding.json").unlink(missing_ok=True)

    history = [
        {
            "id": "before",
            "type": "agent.message",
            "content": [{"type": "text", "text": "already imported"}],
        },
        {
            "id": "missed",
            "type": "agent.message",
            "content": [{"type": "text", "text": "offline output"}],
        },
        call("pending", "agent.custom_tool_use"),
        idle(["pending"]),
    ]
    invoked = []
    fake = RecoveryClient([history])
    first = new_agent(
        fake,
        DiskStore(),
        resolve_session=lambda _: SessionBinding("native", last_event_id="before"),
        backend_tools=[
            BackendTool("lookup", "lookup", {}, lambda value: invoked.append(value))
        ],
    )
    events = await collect(first, base_input())
    assert [e.delta for e in events if e.type.value == "TEXT_MESSAGE_CONTENT"] == [
        "offline output"
    ]
    assert len([e for e in events if e.type.value == "RAW"]) == 3
    assert not invoked and not fake.sent
    assert [e.tool_call_id for e in events if e.type.value == "TOOL_CALL_START"] == [
        "pending"
    ]
    # A new store and adapter instance read only the serialized record.
    second_fake = RecoveryClient([history])
    second = new_agent(second_fake, DiskStore())
    events = await collect(second, base_input())
    assert not [e for e in events if e.type.value in ("TEXT_MESSAGE_CONTENT", "RAW")]
    assert not second_fake.sent and not second_fake.create_calls


async def test_end_turn_invalidates_stale_calls_and_unknown_blocker_errors():
    fake = RecoveryClient(
        [
            [
                call("stale"),
                {
                    "id": "end",
                    "type": "session.status_idle",
                    "stop_reason": {"type": "end_turn"},
                },
            ]
        ]
    )
    events = await collect(
        new_agent(fake, resolve_session=lambda _: SessionBinding("native")),
        base_input(),
    )
    assert events[-1].outcome is None
    assert not fake.sent
    fake = RecoveryClient([[idle(["missing"])]])
    events = await collect(
        new_agent(fake, resolve_session=lambda _: SessionBinding("native")),
        base_input(),
    )
    assert events[-1].code == "pending_request_unavailable"
    assert not fake.sent


async def test_live_overlap_deduplicated_and_cursor_persisted():
    old = {
        "id": "old",
        "type": "agent.message",
        "content": [{"type": "text", "text": "old"}],
    }
    new = {
        "id": "new",
        "type": "agent.message",
        "content": [{"type": "text", "text": "new"}],
    }
    fake = RecoveryClient(
        [[old, {"id": "running", "type": "session.status_running"}]],
        streams=[
            [
                old,
                new,
                {
                    "id": "done",
                    "type": "session.status_idle",
                    "stop_reason": {"type": "end_turn"},
                },
            ]
        ],
    )
    store = InMemorySessionStore()
    agent = new_agent(fake, store, resolve_session=lambda _: SessionBinding("native"))
    events = await collect(agent, base_input())
    assert [e.delta for e in events if e.type.value == "TEXT_MESSAGE_CONTENT"] == [
        "new"
    ]
    assert store.get(agent._session_key("thread_1")).last_event_id == "done"


async def test_resume_without_binding_does_not_create_session():
    fake = FakeClient()
    events = await collect(
        new_agent(fake),
        base_input(
            resume=[
                {"interruptId": "unknown", "status": "resolved", "payload": "allow"}
            ]
        ),
    )
    assert events[-1].code == "invalid_resume"
    assert not fake.create_calls and not fake.sent


async def test_live_child_termination_retains_ended_binding():
    fake = RecoveryClient(
        [[{"id": "running", "type": "session.thread_status_running"}]],
        streams=[[{"id": "terminated", "type": "session.thread_status_terminated"}]],
    )
    store = InMemorySessionStore()
    agent = new_agent(
        fake,
        store,
        resolve_session=lambda _: SessionBinding("native", session_thread_id="child"),
    )
    events = await collect(agent, base_input())
    assert events[-1].code == "session_ended"
    assert store.get(agent._session_key("thread_1")).ended
    assert not fake.sent


async def test_owned_session_without_cursor_replays_history():
    from ag_ui_claude_managed_agents import SessionRecord

    fake = RecoveryClient(
        [
            [
                {
                    "id": "offline",
                    "type": "agent.message",
                    "content": [{"type": "text", "text": "finished offline"}],
                },
                {
                    "id": "end",
                    "type": "session.status_idle",
                    "stop_reason": {"type": "end_turn"},
                },
            ]
        ]
    )
    store = InMemorySessionStore()
    agent = new_agent(fake, store)
    store.set(
        agent._session_key("thread_1"),
        SessionRecord("native", last_user_message_id="u1"),
    )
    events = await collect(agent, base_input())
    assert [e.delta for e in events if e.type.value == "TEXT_MESSAGE_CONTENT"] == [
        "finished offline"
    ]
    assert not fake.sent


async def test_recovered_live_unknown_tool_is_parked_without_rejection():
    fake = RecoveryClient(
        [[{"id": "running", "type": "session.status_running"}]],
        streams=[[call("new-call", "agent.custom_tool_use")]],
    )
    store = InMemorySessionStore()
    agent = new_agent(fake, store, resolve_session=lambda _: SessionBinding("native"))
    events = await collect(agent, base_input())
    assert events[-1].type.value == "RUN_FINISHED"
    assert store.get(agent._session_key("thread_1")).pending_client_tool_use_ids == [
        "new-call"
    ]
    assert not fake.sent


async def test_recovered_live_approval_ignores_automatic_policy():
    fake = RecoveryClient(
        [[{"id": "running", "type": "session.status_running"}]], streams=[[call("ask")]]
    )
    agent = new_agent(
        fake,
        resolve_session=lambda _: SessionBinding("native"),
        tool_confirmation="allow",
    )
    events = await collect(agent, base_input())
    interrupt = events[-1].outcome.interrupts[0]
    assert interrupt.id == "ask"
    assert interrupt.response_schema == {"type": "string", "enum": ["allow", "deny"]}
    assert interrupt.metadata["sessionId"] == "native"
    assert interrupt.metadata["toolName"] == "lookup"
    assert not fake.sent


async def test_recovered_unknown_live_action_does_not_interrupt():
    fake = RecoveryClient(
        [[{"id": "running", "type": "session.status_running"}]],
        streams=[[idle(["unknown"])]],
    )
    events = await collect(
        new_agent(fake, resolve_session=lambda _: SessionBinding("native")),
        base_input(),
    )
    assert events[-1].code == "unsupported_action"
    assert not fake.sent


async def test_completed_offline_custom_lifecycle_is_replayed_without_execution():
    history = [
        {"id": "cursor", "type": "session.status_running"},
        call("custom", "agent.custom_tool_use"),
        {
            "id": "answer",
            "type": "user.custom_tool_result",
            "custom_tool_use_id": "custom",
            "content": [{"type": "text", "text": "offline result"}],
        },
        {
            "id": "end",
            "type": "session.status_idle",
            "stop_reason": {"type": "end_turn"},
        },
    ]
    fake = RecoveryClient([history])
    agent = new_agent(
        fake, resolve_session=lambda _: SessionBinding("native", last_event_id="cursor")
    )
    events = await collect(agent, base_input())
    assert [e.type.value for e in events if e.type.value.startswith("TOOL_CALL")] == [
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "TOOL_CALL_RESULT",
    ]
    result = next(e for e in events if e.type.value == "TOOL_CALL_RESULT")
    assert result.tool_call_id == "custom" and "offline result" in result.content
    assert not fake.sent


async def test_missing_cursor_is_explicit_and_not_advanced():
    fake = RecoveryClient(
        [
            [
                {
                    "id": "end",
                    "type": "session.status_idle",
                    "stop_reason": {"type": "end_turn"},
                }
            ]
        ]
    )
    store = InMemorySessionStore()
    agent = new_agent(
        fake,
        store,
        resolve_session=lambda _: SessionBinding("native", last_event_id="missing"),
    )
    events = await collect(agent, base_input())
    assert events[-1].code == "history_cursor_unavailable"
    assert store.get(agent._session_key("thread_1")).last_event_id == "missing"
    assert not fake.sent


async def test_failed_event_translation_does_not_advance_cursor():
    import pytest
    from ag_ui_claude_managed_agents.turn import _consume
    from .fake_client import FakeStream

    observed = []

    def fail_emit(event):
        if event.type.value == "TEXT_MESSAGE_CONTENT":
            raise RuntimeError("consumer failed")

    with pytest.raises(RuntimeError, match="consumer failed"):
        await _consume(
            client=FakeClient(),
            session_id="native",
            stream=FakeStream(
                [
                    {
                        "id": "message",
                        "type": "agent.message",
                        "content": [{"type": "text", "text": "hello"}],
                    }
                ]
            ),
            client_tools={},
            backend_tools={},
            tool_confirmation=None,
            emit=fail_emit,
            on_event=lambda event: observed.append(event),
        )
    assert observed == []


async def test_custom_pending_and_replayed_names_match_frontend_tools():
    tools = [{"name": "show chart", "description": "show", "parameters": {}}]
    pending = {
        "id": "chart",
        "type": "agent.custom_tool_use",
        "name": "show_chart",
        "input": {},
    }
    for cursor in (None, "before"):
        fake = RecoveryClient(
            [
                [
                    {"id": "before", "type": "session.status_running"},
                    pending,
                    idle(["chart"]),
                ]
            ]
        )
        agent = new_agent(
            fake,
            resolve_session=lambda _: SessionBinding("native", last_event_id=cursor),
        )
        events = await collect(agent, base_input(tools=tools))
        assert [
            e.tool_call_name for e in events if e.type.value == "TOOL_CALL_START"
        ] == ["show chart"]
        assert not fake.sent


async def test_pending_calls_in_assistant_history_are_not_emitted_twice():
    fake = RecoveryClient(
        [[call("existing", "agent.custom_tool_use"), idle(["existing"])]]
    )
    agent = new_agent(fake, resolve_session=lambda _: SessionBinding("native"))
    events = await collect(
        agent,
        base_input(
            messages=[
                {"id": "u1", "role": "user", "content": "hello"},
                {
                    "id": "a1",
                    "role": "assistant",
                    "toolCalls": [
                        {
                            "id": "existing",
                            "type": "function",
                            "function": {"name": "lookup", "arguments": "{}"},
                        }
                    ],
                },
            ]
        ),
    )
    assert not [e for e in events if e.type.value.startswith("TOOL_CALL")]
    assert events[-1].type.value == "RUN_FINISHED"
    assert not fake.sent


async def test_recovered_results_ignore_buffered_requires_action_for_submitted_ids():
    for kind in ("agent.custom_tool_use", "agent.tool_use", "agent.mcp_tool_use"):
        fake = RecoveryClient(
            [[call("c1", kind)]],
            streams=[
                [
                    idle(["c1"]),
                    {
                        "id": "reply",
                        "type": "agent.message",
                        "content": [{"type": "text", "text": "continued"}],
                    },
                    {
                        "id": "done",
                        "type": "session.status_idle",
                        "stop_reason": {"type": "end_turn"},
                    },
                ]
            ],
        )
        agent = new_agent(fake, resolve_session=lambda _: SessionBinding("native"))
        data = {"messages": []}
        if kind == "agent.custom_tool_use":
            data["messages"] = [
                {"id": "result", "role": "tool", "toolCallId": "c1", "content": "ok"}
            ]
        else:
            data["resume"] = [
                {"interruptId": "c1", "status": "resolved", "payload": "allow"}
            ]
        events = await collect(agent, base_input(**data))
        assert events[-1].type.value == "RUN_FINISHED", kind
        assert [e.delta for e in events if e.type.value == "TEXT_MESSAGE_CONTENT"] == [
            "continued"
        ], kind
        assert len(fake.sent) == 1 and len(fake.sent[0]["events"]) == 1, kind
        assert fake.sent[0]["events"][0]["type"] == (
            "user.custom_tool_result"
            if kind == "agent.custom_tool_use"
            else "user.tool_confirmation"
        )


async def test_recovered_text_reconciles_existing_prefix_complete_and_conflict():
    for displayed, expected in (
        ("hello", " world"),
        ("hello world", ""),
        ("different", None),
    ):
        fake = RecoveryClient(
            [
                [
                    {"id": "cursor", "type": "session.status_running"},
                    {
                        "id": "message",
                        "type": "agent.message",
                        "content": [{"type": "text", "text": "hello world"}],
                    },
                    {
                        "id": "done",
                        "type": "session.status_idle",
                        "stop_reason": {"type": "end_turn"},
                    },
                ]
            ]
        )
        store = InMemorySessionStore()
        agent = new_agent(
            fake,
            store,
            resolve_session=lambda _: SessionBinding("native", last_event_id="cursor"),
        )
        events = await collect(
            agent,
            base_input(
                messages=[{"id": "message", "role": "assistant", "content": displayed}]
            ),
        )
        text_events = [e for e in events if e.type.value.startswith("TEXT_MESSAGE")]
        if expected is None:
            assert events[-1].code == "history_content_conflict"
            assert store.get(agent._session_key("thread_1")).last_event_id == "cursor"
            assert not text_events
        elif expected:
            assert events[-1].type.value == "RUN_FINISHED"
            assert [
                e.delta for e in text_events if e.type.value == "TEXT_MESSAGE_CONTENT"
            ] == [expected]
            assert all(e.message_id == "message" for e in text_events)
        else:
            assert events[-1].type.value == "RUN_FINISHED"
            assert not text_events
        assert not fake.sent


async def test_recovered_history_answers_ignore_late_live_requires_action():
    for kind in ("agent.custom_tool_use", "agent.tool_use", "agent.mcp_tool_use"):
        answer = (
            {
                "id": "answered",
                "type": "user.custom_tool_result",
                "custom_tool_use_id": "c1",
                "content": [{"type": "text", "text": "ok"}],
            }
            if kind == "agent.custom_tool_use"
            else {
                "id": "answered",
                "type": "user.tool_confirmation",
                "tool_use_id": "c1",
                "result": "allow",
            }
        )
        fake = RecoveryClient(
            [
                [
                    call("c1", kind),
                    answer,
                    {"id": "running", "type": "session.status_running"},
                ]
            ],
            streams=[
                [
                    idle(["c1"]),
                    {
                        "id": "reply",
                        "type": "agent.message",
                        "content": [{"type": "text", "text": "continued"}],
                    },
                    {
                        "id": "done",
                        "type": "session.status_idle",
                        "stop_reason": {"type": "end_turn"},
                    },
                ]
            ],
        )
        events = await collect(
            new_agent(fake, resolve_session=lambda _: SessionBinding("native")),
            base_input(),
        )
        assert events[-1].type.value == "RUN_FINISHED", kind
        assert [e.delta for e in events if e.type.value == "TEXT_MESSAGE_CONTENT"] == [
            "continued"
        ], kind
        assert not fake.sent, kind


async def test_rich_recovered_results_preserve_native_ids_content_and_single_raw():
    content = [
        {"type": "text", "text": "  " + "x" * 30000 + "\n"},
        {
            "type": "image",
            "source": {"type": "base64", "data": "AAEC", "media_type": "image/png"},
        },
    ]
    for kind, field in [
        ("agent.tool_result", "tool_use_id"),
        ("agent.mcp_tool_result", "mcp_tool_use_id"),
        ("user.custom_tool_result", "custom_tool_use_id"),
    ]:
        native = {
            "type": kind,
            "id": "native-result",
            field: "native-call",
            "is_error": True,
            "content": content,
        }
        history = [
            {"id": "cursor", "type": "session.status_running"},
            native,
            {
                "id": "done",
                "type": "session.status_idle",
                "stop_reason": {"type": "end_turn"},
            },
        ]
        fake = RecoveryClient([history])
        store = InMemorySessionStore()
        subject = new_agent(
            fake,
            store,
            resolve_session=lambda _: SessionBinding("native", last_event_id="cursor"),
        )
        events = [e async for e in subject.run(base_input())]
        raw = [
            e
            for e in events
            if e.type.value == "RAW" and e.event.get("id") == "native-result"
        ]
        assert (
            len(raw) == 1
            and raw[0].event == native
            and raw[0].source == "claude-managed-agents"
        )
        result = next(e for e in events if e.type.value == "TOOL_CALL_RESULT")
        assert (
            result.message_id == "native-result"
            and result.tool_call_id == "native-call"
        )
        assert [
            part.metadata["claudeManagedAgents"] for part in result.content
        ] == content
        assert all(part.metadata["isError"] is True for part in result.content)
        assert store.get(subject._session_key("thread_1")).last_event_id == "done"
        assert not fake.sent


async def test_captured_child_results_cold_allow_deny_and_restart():
    import json
    from pathlib import Path

    fixtures = json.loads(
        (Path(__file__).parents[2] / "fixtures" / "child-results.json").read_text()
    )
    for row in fixtures.values():
        native_call = row["root"][0]
        result = next(e for e in row["native"] if e["type"] == "agent.tool_result")
        thread = native_call["session_thread_id"]
        done = {
            "id": "done",
            "type": "session.status_idle",
            "stop_reason": {"type": "end_turn"},
        }
        store = InMemorySessionStore()
        fake = RecoveryClient([[native_call]], streams=[[row["root"][1], done]])

        async def child_history(identity, *, session_id):
            assert identity == thread and session_id == "native"
            return Page([row["native"][:-1], [result, result]])

        fake.beta.sessions.threads.events.list = child_history
        first = new_agent(
            fake,
            store,
            resolve_session=lambda _: SessionBinding(
                "native", last_user_message_id="u1"
            ),
        )
        events = await collect(
            first,
            base_input(
                resume=[
                    {
                        "interruptId": native_call["id"],
                        "status": "resolved",
                        "payload": row["root"][1]["result"],
                    }
                ]
            ),
        )
        results = [e for e in events if e.type == "TOOL_CALL_RESULT"]
        assert len(results) == 1
        assert results[0].tool_call_id == native_call["id"]
        assert results[0].message_id == result["id"]
        assert (json.loads(results[0].content) if result["is_error"] else results[0].content) == ({"error": True, "content": result["content"][0]["text"]} if result["is_error"] else result["content"][0]["text"])
        assert any(
            e.type == "RAW"
            and e.event.get("id") == result["id"]
            and e.event.get("session_thread_id") == thread
            and e.event.get("is_error") == result["is_error"]
            for e in events
        )
        restarted = RecoveryClient([[*row["root"], done, result]])
        restarted.beta.sessions.threads.events.list = child_history
        replay = await collect(new_agent(restarted, store), base_input())
        assert not [e for e in replay if e.type == "TOOL_CALL_RESULT"]
        assert replay[-1].type == "RUN_FINISHED"


async def test_child_results_require_exact_call_and_scope():
    from ag_ui_claude_managed_agents.recovery import recover_child_results
    from ag_ui_claude_managed_agents.types import SessionRecord

    fake = RecoveryClient([[]])

    async def history(*args, **kwargs):
        return [
            {
                "type": "agent.tool_result",
                "id": "wrong-call",
                "tool_use_id": "other",
                "content": [],
            },
            {
                "type": "agent.tool_result",
                "id": "wrong-thread",
                "tool_use_id": "call",
                "session_thread_id": "other",
                "content": [],
            },
            {
                "type": "user.tool_confirmation",
                "tool_use_id": "call",
                "result": "allow",
            },
            {"type": "agent.message", "content": [{"type": "text", "text": "Done!"}]},
        ]

    fake.beta.sessions.threads.events.list = history
    record = SessionRecord(session_id="native", child_tool_calls={"call": "child"})
    events = []
    await recover_child_results(fake, record, events.append)
    assert not events


async def test_child_result_missing_at_root_completion_is_recovered_on_reload(tmp_path):
    import json
    from dataclasses import asdict
    from ag_ui_claude_managed_agents.types import SessionRecord

    class DiskStore:
        def get(self, key):
            path = tmp_path / "session.json"
            return (
                SessionRecord(**json.loads(path.read_text())) if path.exists() else None
            )

        def set(self, key, record):
            (tmp_path / "session.json").write_text(json.dumps(asdict(record)))

    native_call = call("child-call", session_thread_id="child")
    done = {
        "id": "done",
        "type": "session.status_idle",
        "stop_reason": {"type": "end_turn"},
    }
    fake = RecoveryClient([[native_call, done]])

    async def empty(*args, **kwargs):
        return []

    fake.beta.sessions.threads.events.list = empty
    first = new_agent(
        fake,
        DiskStore(),
        resolve_session=lambda _: SessionBinding("native", last_user_message_id="u1"),
    )
    assert not [
        e for e in await collect(first, base_input()) if e.type == "TOOL_CALL_RESULT"
    ]

    async def late(*args, **kwargs):
        return [
            {
                "type": "agent.tool_result",
                "id": "late",
                "tool_use_id": "child-call",
                "content": [{"type": "text", "text": "exact result"}],
            }
        ]

    restarted = RecoveryClient([[native_call, done]])
    restarted.beta.sessions.threads.events.list = late
    events = await collect(new_agent(restarted, DiskStore()), base_input())
    assert [e.content for e in events if e.type == "TOOL_CALL_RESULT"] == [
        "exact result"
    ]


async def test_transcript_known_child_result_survives_transcript_omission():
    from .fake_store import RecordingSessionStore

    native_call = call("known-call", session_thread_id="child")
    done = {
        "id": "done",
        "type": "session.status_idle",
        "stop_reason": {"type": "end_turn"},
    }
    result = {
        "id": "known-result",
        "type": "agent.tool_result",
        "tool_use_id": "known-call",
        "content": [{"type": "text", "text": "done"}],
    }
    store = RecordingSessionStore()

    def make():
        fake = RecoveryClient([[native_call, done]])

        async def child_history(*args, **kwargs):
            return [result]

        fake.beta.sessions.threads.events.list = child_history
        return new_agent(
            fake,
            store,
            resolve_session=lambda _: SessionBinding(
                "native", last_user_message_id="u1"
            ),
        )

    first = await collect(
        make(),
        base_input(
            messages=[
                {
                    "role": "tool",
                    "id": "known-result",
                    "toolCallId": "known-call",
                    "content": "done",
                }
            ]
        ),
    )
    assert not [e for e in first if e.type == "TOOL_CALL_RESULT"]
    replay = await collect(make(), base_input(messages=[]))
    assert replay[-1].type == "RUN_FINISHED"
    assert not [e for e in replay if e.type == "TOOL_CALL_RESULT"]


async def test_initial_child_results_are_recovered_and_deduplicated_after_restart():
    from .fake_store import RecordingSessionStore

    for cross_posted in (False, True):
        native_call = call("initial-call", session_thread_id="child")
        done = {
            "id": "done",
            "type": "session.status_idle",
            "stop_reason": {"type": "end_turn"},
        }
        result = {
            "id": "initial-result",
            "type": "agent.tool_result",
            "tool_use_id": "initial-call",
            "content": [{"type": "text", "text": "done"}],
        }
        store = RecordingSessionStore()
        fake = RecoveryClient(
            [[]], streams=[[native_call, *([result] if cross_posted else []), done]]
        )

        async def child_history(*args, **kwargs):
            return [result]

        fake.beta.sessions.threads.events.list = child_history
        events = await collect(
            new_agent(fake, store, tool_confirmation="allow"), base_input()
        )
        assert len([e for e in events if e.type == "TOOL_CALL_RESULT"]) == 1, (
            cross_posted
        )
        assert events[-1].type == "RUN_FINISHED"
        restarted = RecoveryClient([[native_call, done]])
        restarted.beta.sessions.threads.events.list = child_history
        replay = await collect(new_agent(restarted, store), base_input(messages=[]))
        assert replay[-1].type == "RUN_FINISHED"
        assert not [e for e in replay if e.type == "TOOL_CALL_RESULT"], cross_posted
