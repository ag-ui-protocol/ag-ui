import pytest
from ag_ui_claude_managed_agents import InMemorySessionStore, SessionRecord
from .fake_client import FakeClient
from .test_agent import base_input, collect, new_agent, SESSION_KEY, IDLE_END_TURN

@pytest.mark.parametrize("content,error,expected", [
    ("", None, []),
    ([], None, []),
    ([{"type": "text", "text": ""}], None, []),
    ("  answered\n", None, [{"type": "text", "text": "  answered\n"}]),
    ("", "Failed", [{"type": "text", "text": "Failed"}]),
    ([{"type": "text", "text": ""}, {"type": "text", "text": " \n"}, {"type": "image", "source": {"type": "file", "value": "file_1", "provider": "anthropic"}}], None,
     [{"type": "text", "text": " \n"}, {"type": "image", "source": {"type": "file", "file_id": "file_1"}}]),
])
async def test_continues_native_call_once(content, error, expected):
    fake = FakeClient(streams=[[IDLE_END_TURN], [IDLE_END_TURN]])
    store = InMemorySessionStore()
    def pending():
        return SessionRecord(session_id="sesn_original", tool_names=[], pending_client_tool_use_ids=["chart_1"], last_user_message_id="u1")
    store.set(SESSION_KEY, pending())
    value = base_input(messages=[
        {"id": "u1", "role": "user", "content": "Chart"},
        {"id": "t1", "role": "tool", "toolCallId": "chart_1", "content": content, "error": error},
    ])
    # Duplicate frontend delivery within one request still resolves only once.
    value.messages.append(value.messages[-1].model_copy(update={"id": "t1-copy"}))
    events = await collect(new_agent(fake, store), value)
    assert events[-1].type.value == "RUN_FINISHED"
    assert fake.sent == [{"session_id": "sesn_original", "events": [{
        "type": "user.custom_tool_result", "custom_tool_use_id": "chart_1",
        "content": expected, "is_error": bool(error),
    }]}]
    assert store.get(SESSION_KEY).pending_client_tool_use_ids == []
    # Rebuild from native history after losing local delivery bookkeeping.
    store.set(SESSION_KEY, pending())
    await collect(new_agent(fake, store), value)
    assert len(fake.sent) == 1
    assert fake.create_calls == []
    assert store.get(SESSION_KEY).pending_client_tool_use_ids == []
