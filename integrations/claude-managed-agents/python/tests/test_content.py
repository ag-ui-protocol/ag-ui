import json
import pytest
from .fake_client import FakeClient
from .test_agent import base_input, new_agent, IDLE_END_TURN

async def run(parts, native=()):
    fake = FakeClient(streams=[[*native, IDLE_END_TURN]])
    value = base_input(state={"cart": {"total": 42}}, messages=[{"id": "original-user", "role": "user", "content": parts}])
    events = [e.model_dump(mode="json", by_alias=True, exclude_none=True) async for e in new_agent(fake).run(value)]
    return fake, value, events

@pytest.mark.parametrize("kind,mime", [("image", "image/png"), ("document", "application/pdf")])
async def test_media_sources_and_original_recorder_input(kind, mime):
    parts = [{"type": kind, "source": {"type": "data", "value": "AAEC/w==", "mimeType": mime}, "metadata": {"filename": "original.bin"}}, {"type": kind, "source": {"type": "url", "value": "https://example.test/media", "mimeType": mime}}, {"type": kind, "source": {"type": "file", "value": "file_native", "provider": "anthropic"}}]
    fake, value, events = await run(parts)
    assert events[0]["input"] == value.model_dump(mode="json", by_alias=True, exclude_none=True)
    assert next(event["snapshot"] for event in events if event["type"] == "STATE_SNAPSHOT") == value.state
    blocks = fake.sent[0]["events"][0]["content"]
    assert blocks[0]["source"] == {"type": "base64", "data": "AAEC/w==", "media_type": mime}
    assert blocks[1]["source"] == {"type": "url", "url": "https://example.test/media"}
    assert blocks[2]["source"] == {"type": "file", "file_id": "file_native"}
    assert events[-1]["type"] == "RUN_FINISHED"

@pytest.mark.parametrize("kind", ["audio", "video"])
async def test_unsupported_media_is_recorded_while_supported_parts_are_sent(kind):
    fake, value, events = await run([{"type": "text", "text": "  hello\n"}, {"type": kind, "source": {"type": "data", "value": "AAEC", "mimeType": kind + "/test"}, "metadata": {"filename": "original"}}])
    assert events[0]["input"] == value.model_dump(mode="json", by_alias=True, exclude_none=True)
    assert events[-1]["type"] == "RUN_FINISHED"
    assert fake.sent[0]["events"][0]["content"] == [{"type": "text", "text": "  hello\n"}]

async def test_foreign_file_handle_is_not_reinterpreted():
    fake, _, events = await run([{"type": "image", "source": {"type": "file", "value": "opaque", "provider": "openai"}}])
    assert events[-1]["code"] == "empty_run"
    assert fake.sent == []

async def test_full_native_results_and_unknown_rich_events():
    content = [{"type": "text", "text": "  " + "x" * 30000 + "\n"}, {"type": "image", "source": {"type": "base64", "data": "AAEC/w==", "media_type": "image/png"}}, {"type": "search_result", "title": "A &amp; B", "source": "https://example.test", "content": [{"type": "text", "text": "y" * 2000}]}]
    native = [{"type": "agent.mcp_tool_result", "id": "original-result", "mcp_tool_use_id": "original-call", "is_error": True, "content": content}, {"type": "agent.future_rich_event", "id": "rich", "payload": {"ui": [1, 2]}}]
    _, _, events = await run([{"type": "text", "text": "hello"}], native)
    assert [e["event"] for e in events if e["type"] == "RAW"] == native
    result = next(e for e in events if e["type"] == "TOOL_CALL_RESULT")
    assert result["messageId"] == "original-result"
    assert result["toolCallId"] == "original-call"
    assert [part["metadata"]["claudeManagedAgents"] for part in result["content"]] == content
    assert all(part["metadata"]["isError"] is True for part in result["content"])
    assert result["content"][1]["source"] == {"type": "data", "value": "AAEC/w==", "mimeType": "image/png"}

async def test_existing_unsupported_history_does_not_block_pending_tool_result():
    from ag_ui_claude_managed_agents import InMemorySessionStore, SessionRecord
    from .test_agent import SESSION_KEY
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    store = InMemorySessionStore()
    store.set(SESSION_KEY, SessionRecord(session_id="sesn_1", tool_names=[], pending_client_tool_use_ids=["ctu_1"], last_user_message_id="u1"))
    value = base_input(messages=[
        {"id": "u1", "role": "user", "content": [{"type": "audio", "source": {"type": "url", "value": "https://example.test/audio"}}]},
        {"id": "t1", "role": "tool", "toolCallId": "ctu_1", "content": "answered"},
    ])
    events = [e.model_dump(mode="json", by_alias=True) async for e in new_agent(fake, store).run(value)]
    assert events[-1]["type"] == "RUN_FINISHED"
    assert fake.sent[0]["events"] == [{"type": "user.custom_tool_result", "custom_tool_use_id": "ctu_1", "content": [{"type": "text", "text": "answered"}], "is_error": False}]
    assert fake.create_calls == []

async def test_sdk_model_raw_event_preserves_explicit_null_and_omitted_fields():
    from anthropic.types.beta.sessions.beta_managed_agents_agent_mcp_tool_result_event import BetaManagedAgentsAgentMCPToolResultEvent
    native = BetaManagedAgentsAgentMCPToolResultEvent(id="native-result", mcp_tool_use_id="native-call", processed_at="2026-01-01T00:00:00Z", type="agent.mcp_tool_result", content=None)
    _, _, events = await run([{"type": "text", "text": "hello"}], [native])
    raw = next(e["event"] for e in events if e["type"] == "RAW")
    assert raw == native.model_dump(mode="json", by_alias=True, exclude_unset=True)
    assert "content" in raw and raw["content"] is None
    assert "is_error" not in raw

@pytest.mark.parametrize("mixed", [False, True])
async def test_unsupported_tool_parts_skip_and_preserve_supported_content(mixed):
    from ag_ui_claude_managed_agents import InMemorySessionStore, SessionRecord
    from .test_agent import SESSION_KEY
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    store = InMemorySessionStore()
    store.set(SESSION_KEY, SessionRecord(session_id="sesn_1", tool_names=[], pending_client_tool_use_ids=["ctu_1"], last_user_message_id="u1"))
    parts = [{"type": "audio", "source": {"type": "url", "value": "https://example.test/audio"}}, {"type": "image", "source": {"type": "file", "value": "foreign", "provider": "openai"}}, {"type": "image", "source": {"type": "data", "value": "AAEC", "mimeType": "image/tiff"}}]
    if mixed:
        parts += [{"type": "text", "text": "  meaningful\n"}, {"type": "text", "text": " \n"}, {"type": "image", "source": {"type": "url", "value": "https://example.test/image"}}]
    value = base_input(messages=[{"id": "u1", "role": "user", "content": "Hello"}, {"id": "t1", "role": "tool", "toolCallId": "ctu_1", "content": parts}])
    events = [e async for e in new_agent(fake, store).run(value)]
    assert events[0].input == value
    expected = [{"type": "text", "text": "  meaningful\n"}, {"type": "text", "text": " \n"}, {"type": "image", "source": {"type": "url", "url": "https://example.test/image"}}] if mixed else []
    assert fake.sent[0]["events"][0]["content"] == expected
    assert store.get(SESSION_KEY).pending_client_tool_use_ids == []
    assert events[-1].type.value == "RUN_FINISHED"

@pytest.mark.parametrize("content", [" \n", [{"type": "text", "text": " \n"}], [{"type": "audio", "source": {"type": "url", "value": "https://example.test/audio"}}, {"type": "text", "text": " \n"}]])
async def test_blank_user_does_not_abandon_pending_calls_or_advance_cursor(content):
    from ag_ui_claude_managed_agents import InMemorySessionStore, SessionRecord
    from .test_agent import SESSION_KEY
    fake = FakeClient(streams=[])
    store = InMemorySessionStore()
    store.set(SESSION_KEY, SessionRecord(session_id="sesn_1", tool_names=[], pending_client_tool_use_ids=["ctu_1"], last_user_message_id="u1"))
    value = base_input(messages=[{"id": "u1", "role": "user", "content": "Hello"}, {"id": "u2", "role": "user", "content": content}])
    events = [e async for e in new_agent(fake, store).run(value)]
    assert fake.sent == []
    assert store.get(SESSION_KEY).pending_client_tool_use_ids == ["ctu_1"]
    assert store.get(SESSION_KEY).last_user_message_id == "u1"

async def test_failed_delivery_of_filtered_empty_tool_reply_retains_pending():
    from ag_ui_claude_managed_agents import SessionRecord
    from .test_agent import SESSION_KEY, RecordingSessionStore
    fake = FakeClient(streams=[[IDLE_END_TURN]], send_failures={0: RuntimeError("delivery failed")})
    store = RecordingSessionStore()
    store.set(SESSION_KEY, SessionRecord(session_id="sesn_1", tool_names=[], pending_client_tool_use_ids=["ctu_1"], last_user_message_id="u1"))
    value = base_input(messages=[{"id": "u1", "role": "user", "content": "Hello"}, {"id": "t1", "role": "tool", "toolCallId": "ctu_1", "content": [{"type": "audio", "source": {"type": "url", "value": "https://example.test/audio"}}]}])
    events = [e async for e in new_agent(fake, store).run(value)]
    assert events[-1].type.value == "RUN_ERROR"
    assert store.get(SESSION_KEY).pending_client_tool_use_ids == ["ctu_1"]

async def test_meaningful_user_text_preserves_blank_separators():
    parts = [{"type": "text", "text": "START"}, {"type": "text", "text": "\n"}, {"type": "text", "text": "END"}]
    fake, value, events = await run(parts)
    assert fake.sent[0]["events"][0]["content"] == parts
    assert events[0]["input"] == value.model_dump(mode="json", by_alias=True, exclude_none=True)
    assert events[-1]["type"] == "RUN_FINISHED"

async def test_supported_user_media_preserves_adjacent_blank_text():
    fake, _, events = await run([{"type": "image", "source": {"type": "url", "value": "https://example.test/image"}}, {"type": "text", "text": " \n"}])
    assert fake.sent[0]["events"][0]["content"] == [{"type": "image", "source": {"type": "url", "url": "https://example.test/image"}}, {"type": "text", "text": " \n"}]
    assert events[-1]["type"] == "RUN_FINISHED"

@pytest.mark.parametrize("mixed", [False, True])
async def test_text_document_uses_utf8_text_source_preserving_original_input(mixed):
    import base64
    import copy
    text = "\ufeff  café 日本語 😀\r\nPARITY42\n"
    parts = [{"type": "document", "source": {"type": "data", "value": base64.b64encode(text.encode()).decode(), "mimeType": "text/plain"}, "metadata": {"filename": "note.txt"}}]
    if mixed:
        parts += [
            {"type": "image", "source": {"type": "data", "value": "AAEC/w==", "mimeType": "image/png"}},
            {"type": "document", "source": {"type": "data", "value": "JVBERi0=", "mimeType": "application/pdf"}},
            {"type": "audio", "source": {"type": "data", "value": "AAEC", "mimeType": "audio/wav"}},
        ]
    original = copy.deepcopy(parts)
    fake, value, events = await run(parts)
    assert events[0]["input"]["messages"][0]["content"] == original
    assert parts == original
    blocks = fake.sent[0]["events"][0]["content"]
    assert blocks[0] == {"type": "document", "title": "note.txt", "source": {"type": "text", "media_type": "text/plain", "data": text}}
    assert len(blocks) == (3 if mixed else 1)
    if mixed:
        assert blocks[1:] == [
            {"type": "image", "source": {"type": "base64", "data": "AAEC/w==", "media_type": "image/png"}},
            {"type": "document", "source": {"type": "base64", "data": "JVBERi0=", "media_type": "application/pdf"}},
        ]
    assert events[-1]["type"] == "RUN_FINISHED"


def test_legacy_binary_text_document():
    import base64
    from ag_ui_claude_managed_agents.content import user_content
    text = "  café\r\n"
    assert user_content({"content": [{"type": "binary", "data": base64.b64encode(text.encode()).decode(), "mimeType": "text/plain", "filename": "legacy.txt"}]}) == [{"type": "document", "title": "legacy.txt", "source": {"type": "text", "media_type": "text/plain", "data": text}}]


@pytest.mark.parametrize("data", ["%%%", "/w=="])
async def test_malformed_text_document_is_rejected_without_replacing_bytes(data):
    import copy
    parts = [{"type": "document", "source": {"type": "data", "value": data, "mimeType": "text/plain"}, "metadata": {"filename": "invalid.txt"}}]
    original = copy.deepcopy(parts)
    fake, _, events = await run(parts)
    assert events[0]["input"]["messages"][0]["content"] == original
    assert events[-1]["type"] == "RUN_ERROR"
    assert fake.sent == []


@pytest.mark.parametrize("is_error", [True, False])
@pytest.mark.parametrize("kind,field", [("agent.tool_result", "tool_use_id"), ("agent.mcp_tool_result", "mcp_tool_use_id")])
async def test_native_result_status_identity_and_continuation(is_error, kind, field):
    text = "Permission to use read has been rejected."
    native = {"type": kind, "id": "native-result", field: "native-call", "is_error": is_error, "content": [{"type": "text", "text": text}]}
    _, _, events = await run([{"type": "text", "text": "hello"}], [native])
    results = [e for e in events if e["type"] == "TOOL_CALL_RESULT"]
    assert len(results) == 1
    assert results[0]["messageId"] == "native-result"
    assert results[0]["toolCallId"] == "native-call"
    assert (json.loads(results[0]["content"]) if is_error else results[0]["content"]) == ({"error": True, "content": text} if is_error else text)
    assert events[-1]["type"] == "RUN_FINISHED"
