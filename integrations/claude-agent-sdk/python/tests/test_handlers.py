"""Tests for the Claude SDK stream block handlers.

Exercises tool-use / tool-result block translation and the state-management
interception path. Handlers are async generators, so we collect events.
"""

import json

import pytest

from ag_ui.core import EventType
from ag_ui_claude_sdk.config import STATE_MANAGEMENT_TOOL_FULL_NAME
from ag_ui_claude_sdk.handlers import (
    handle_tool_use_block,
    handle_tool_result_block,
)

from claude_agent_sdk import ToolUseBlock, ToolResultBlock


async def collect(agen):
    return [e async for e in agen]


class _Msg:
    """Stand-in parent message carrying parent_tool_use_id."""

    def __init__(self, parent_tool_use_id=None):
        self.parent_tool_use_id = parent_tool_use_id


class TestHandleToolUseBlock:
    @pytest.mark.asyncio
    async def test_regular_tool_emits_start_args_end(self):
        block = ToolUseBlock(id="tc1", name="mcp__weather__get_weather", input={"city": "NYC"})
        state, gen = await handle_tool_use_block(block, _Msg(), "th", "run", None)
        events = await collect(gen)
        types = [e.type for e in events]
        assert types == [
            EventType.TOOL_CALL_START,
            EventType.TOOL_CALL_ARGS,
            EventType.TOOL_CALL_END,
        ]
        # Name is stripped of the MCP prefix
        assert events[0].tool_call_name == "get_weather"
        assert events[0].tool_call_id == "tc1"
        assert json.loads(events[1].delta) == {"city": "NYC"}

    @pytest.mark.asyncio
    async def test_tool_without_input_skips_args(self):
        block = ToolUseBlock(id="tc2", name="ping", input={})
        _, gen = await handle_tool_use_block(block, _Msg(), "th", "run", None)
        types = [e.type for e in await collect(gen)]
        assert EventType.TOOL_CALL_ARGS not in types
        assert types == [EventType.TOOL_CALL_START, EventType.TOOL_CALL_END]

    @pytest.mark.asyncio
    async def test_missing_id_falls_back_to_generated_uuid(self):
        # A ToolUseBlock with a falsy id must not crash: the handler falls back
        # to a generated uuid. This guards against the `uuid` import living in
        # the module docstring (NameError at the str(uuid.uuid4()) fallback).
        block = ToolUseBlock(id="", name="ping", input={})
        _, gen = await handle_tool_use_block(block, _Msg(), "th", "run", None)
        events = await collect(gen)
        types = [e.type for e in events]
        assert types == [EventType.TOOL_CALL_START, EventType.TOOL_CALL_END]
        # A non-empty fallback id was generated (a uuid4 string).
        assert events[0].tool_call_id
        assert events[0].tool_call_id == events[1].tool_call_id

    @pytest.mark.asyncio
    async def test_state_management_tool_emits_snapshot_and_merges(self):
        block = ToolUseBlock(
            id="tc3",
            name=STATE_MANAGEMENT_TOOL_FULL_NAME,
            input={"state_updates": {"count": 5}},
        )
        new_state, gen = await handle_tool_use_block(
            block, _Msg(), "th", "run", {"count": 1, "name": "a"}
        )
        events = await collect(gen)
        # Only a STATE_SNAPSHOT, no TOOL_CALL_* events
        assert [e.type for e in events] == [EventType.STATE_SNAPSHOT]
        assert events[0].snapshot == {"count": 5, "name": "a"}
        # The RETURNED state must equal the merged snapshot, not the pre-merge
        # state. The adapter persists this dict on the non-streaming path, so a
        # pre-merge return regresses thread state.
        assert new_state == {"count": 5, "name": "a"}

    @pytest.mark.asyncio
    async def test_state_management_tool_json_string_updates(self):
        block = ToolUseBlock(
            id="tc4",
            name=STATE_MANAGEMENT_TOOL_FULL_NAME,
            input={"state_updates": json.dumps({"count": 9})},
        )
        new_state, gen = await handle_tool_use_block(
            block, _Msg(), "th", "run", {"count": 1}
        )
        events = await collect(gen)
        assert events[0].snapshot == {"count": 9}
        # The returned state must equal the merged snapshot (pins the return on
        # the JSON-string variant too).
        assert new_state == {"count": 9}

    @pytest.mark.asyncio
    async def test_state_management_invalid_json_emits_custom_error(self):
        block = ToolUseBlock(
            id="tc5",
            name=STATE_MANAGEMENT_TOOL_FULL_NAME,
            input={"state_updates": "{not valid json"},
        )
        _, gen = await handle_tool_use_block(block, _Msg(), "th", "run", {})
        events = await collect(gen)
        types = [e.type for e in events]
        # Invalid JSON emits ONLY a CUSTOM error event and returns early — no
        # spurious STATE_SNAPSHOT with un-updated state (mirrors the streaming
        # path in adapter.py).
        assert types == [EventType.CUSTOM]
        custom = events[0]
        assert custom.name == "state_update_error"
        assert "error" in custom.value


class TestToolUseBlockParentMessageId:
    @pytest.mark.asyncio
    async def test_parent_message_id_uses_passed_assistant_message_id(self):
        # The streaming path sets ToolCallStartEvent.parent_message_id to the
        # current assistant message id. The non-streaming handler must mirror
        # that — NOT the SDK's parent_tool_use_id (which lives on the message).
        block = ToolUseBlock(id="tc1", name="get_weather", input={"city": "NYC"})
        msg = _Msg(parent_tool_use_id="SHOULD_NOT_BE_USED")
        _, gen = await handle_tool_use_block(
            block, msg, "th", "run", None, parent_message_id="assistant-msg-1"
        )
        events = await collect(gen)
        start = next(e for e in events if e.type == EventType.TOOL_CALL_START)
        assert start.parent_message_id == "assistant-msg-1"
        assert start.parent_message_id != "SHOULD_NOT_BE_USED"


class TestHandleToolResultBlock:
    @pytest.mark.asyncio
    async def test_emits_tool_call_result(self):
        block = ToolResultBlock(
            tool_use_id="tc1",
            content=[{"type": "text", "text": '{"ok": true}'}],
        )
        events = await collect(handle_tool_result_block(block, "th", "run"))
        assert len(events) == 1
        assert events[0].type == EventType.TOOL_CALL_RESULT
        assert events[0].tool_call_id == "tc1"
        assert events[0].message_id == "tc1-result"
        assert json.loads(events[0].content) == {"ok": True}

    @pytest.mark.asyncio
    async def test_is_error_propagated_into_result_content(self):
        # A failed tool result (is_error=True) must not look identical to a
        # successful one. AG-UI's ToolCallResultEvent has no error field, so the
        # error indication is surfaced inside the content envelope.
        block = ToolResultBlock(
            tool_use_id="tc1",
            content=[{"type": "text", "text": "boom"}],
            is_error=True,
        )
        events = await collect(handle_tool_result_block(block, "th", "run"))
        assert len(events) == 1
        payload = json.loads(events[0].content)
        assert payload["error"] is True
        assert payload["content"] == "boom"

    @pytest.mark.asyncio
    async def test_is_error_with_json_object_content_is_single_encoded(self):
        # When the tool result content is itself a JSON object, the error path
        # must stay consistent with the success shape: a single-encoded JSON
        # object carrying an "error": true marker — NOT a double-encoded string
        # nested under "content".
        block = ToolResultBlock(
            tool_use_id="tc1",
            content=[{"type": "text", "text": '{"detail": "nope", "code": 42}'}],
            is_error=True,
        )
        events = await collect(handle_tool_result_block(block, "th", "run"))
        assert len(events) == 1
        payload = json.loads(events[0].content)
        # Single-encoded object: the original fields are top-level dict members,
        # not a re-escaped JSON string under "content".
        assert payload["detail"] == "nope"
        assert payload["code"] == 42
        assert payload["error"] is True
        # Guard against the double-encode regression: "content" must not hold a
        # stringified copy of the JSON object.
        assert not isinstance(payload.get("content"), str)

    @pytest.mark.asyncio
    async def test_is_error_with_surrogate_content_is_repaired(self):
        # A split UTF-16 surrogate pair in error content must be repaired in the
        # emitted payload. The old envelope ran json.dumps over a string that
        # already contained surrogates escaped to literal "\ud83c" text — so
        # fix_surrogates (a UTF-16 round-trip) could not repair it, AND the
        # whole thing got double-encoded under "content". Use JSON-object
        # content carrying the surrogate so both defects are exercised.
        #
        # chr(0xD83C)+chr(0xDF5D) is the lone-surrogate-pair form of 🍝
        # (U+1F35D), as produced when a JS String.slice splits the emoji across
        # stream chunks.
        split_pasta = chr(0xD83C) + chr(0xDF5D)
        block = ToolResultBlock(
            tool_use_id="tc1",
            content=[{"type": "text", "text": json.dumps({"msg": split_pasta})}],
            is_error=True,
        )
        events = await collect(handle_tool_result_block(block, "th", "run"))
        assert len(events) == 1
        payload = json.loads(events[0].content)
        assert payload["error"] is True
        # Single-encoded object: "msg" is a top-level field, not buried in a
        # double-encoded "content" string.
        assert "msg" in payload
        assert not isinstance(payload.get("content"), str)
        # The surrogate is repaired to the real codepoint, not left as a pair of
        # lone surrogates that Pydantic would reject.
        assert payload["msg"] == "\U0001f35d"
        assert len(payload["msg"]) == 1

    @pytest.mark.asyncio
    async def test_success_result_has_no_error_envelope(self):
        block = ToolResultBlock(
            tool_use_id="tc1",
            content=[{"type": "text", "text": '{"ok": true}'}],
            is_error=False,
        )
        events = await collect(handle_tool_result_block(block, "th", "run"))
        # Successful result is the bare payload, not wrapped in an error envelope.
        assert json.loads(events[0].content) == {"ok": True}

    @pytest.mark.asyncio
    async def test_does_not_emit_tool_call_end(self):
        # Regression guard: result handler must NOT re-emit TOOL_CALL_END
        # (that caused "No active tool call" runtime errors).
        block = ToolResultBlock(tool_use_id="tc1", content="plain")
        events = await collect(handle_tool_result_block(block, "th", "run"))
        assert all(e.type != EventType.TOOL_CALL_END for e in events)

    @pytest.mark.asyncio
    async def test_no_tool_use_id_emits_nothing(self):
        block = ToolResultBlock(tool_use_id="", content="x")
        events = await collect(handle_tool_result_block(block, "th", "run"))
        assert events == []
