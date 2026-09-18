"""Tests for the Claude SDK stream block handlers.

Exercises tool-use / tool-result block translation and the state-management
interception path. Handlers are async generators, so we collect events.
"""

import json

import pytest

from ag_ui.core import EventType
from ag_ui_claude_sdk.config import STATE_MANAGEMENT_TOOL_FULL_NAME
from ag_ui_claude_sdk.handlers import (
    SUBAGENT_TASK_ACTIVITY_TYPE,
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
        state, gen = await handle_tool_use_block(block, _Msg(), "th", "run", None, {})
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
        _, gen = await handle_tool_use_block(block, _Msg(), "th", "run", None, {})
        types = [e.type for e in await collect(gen)]
        assert EventType.TOOL_CALL_ARGS not in types
        assert types == [EventType.TOOL_CALL_START, EventType.TOOL_CALL_END]

    @pytest.mark.asyncio
    async def test_missing_id_falls_back_to_generated_uuid(self):
        # A ToolUseBlock with a falsy id must not crash: the handler falls back
        # to a generated uuid. This guards against the `uuid` import living in
        # the module docstring (NameError at the str(uuid.uuid4()) fallback).
        block = ToolUseBlock(id="", name="ping", input={})
        _, gen = await handle_tool_use_block(block, _Msg(), "th", "run", None, {})
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
        new_state, gen = await handle_tool_use_block(block, _Msg(), "th", "run", {"count": 1, "name": "a"}, {})
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
        new_state, gen = await handle_tool_use_block(block, _Msg(), "th", "run", {"count": 1}, {})
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
        _, gen = await handle_tool_use_block(block, _Msg(), "th", "run", {}, {})
        events = await collect(gen)
        types = [e.type for e in events]
        # Invalid JSON emits ONLY a CUSTOM error event and returns early — no
        # spurious STATE_SNAPSHOT with un-updated state (mirrors the streaming
        # path in adapter.py).
        assert types == [EventType.CUSTOM]
        custom = events[0]
        assert custom.name == "state_update_error"
        assert "error" in custom.value


    # ── Item 3: suppress no-op STATE_SNAPSHOT on the non-streaming path ──
    @pytest.mark.asyncio
    async def test_state_management_noop_update_suppresses_snapshot(self):
        # When the merge does not change state, the non-streaming handler must
        # NOT emit a STATE_SNAPSHOT — matching the streaming path, which only
        # emits when the merged state actually changed.
        block = ToolUseBlock(
            id="tc-noop",
            name=STATE_MANAGEMENT_TOOL_FULL_NAME,
            input={"state_updates": {"count": 1}},
        )
        new_state, gen = await handle_tool_use_block(block, _Msg(), "th", "run", {"count": 1}, {})
        events = await collect(gen)
        # No-op merge => no snapshot emitted.
        assert [e.type for e in events] == []
        # Returned state is unchanged (still equal to prior).
        assert new_state == {"count": 1}

    @pytest.mark.asyncio
    async def test_state_management_real_change_still_emits_snapshot(self):
        # A genuine change must still emit exactly one STATE_SNAPSHOT.
        block = ToolUseBlock(
            id="tc-change",
            name=STATE_MANAGEMENT_TOOL_FULL_NAME,
            input={"state_updates": {"count": 2}},
        )
        _, gen = await handle_tool_use_block(block, _Msg(), "th", "run", {"count": 1}, {})
        events = await collect(gen)
        assert [e.type for e in events] == [EventType.STATE_SNAPSHOT]
        assert events[0].snapshot == {"count": 2}

    # ── Item 4: align state_updates extraction with the streaming path ──
    @pytest.mark.asyncio
    async def test_state_updates_key_absent_falls_back_to_whole_object(self):
        # The streaming path (adapter.py) treats the whole parsed object as the
        # updates when the "state_updates" key is absent. The non-streaming
        # handler must behave identically instead of merging an empty {}.
        block = ToolUseBlock(
            id="tc-whole",
            name=STATE_MANAGEMENT_TOOL_FULL_NAME,
            input={"count": 7, "name": "z"},
        )
        new_state, gen = await handle_tool_use_block(block, _Msg(), "th", "run", {"count": 1}, {})
        events = await collect(gen)
        assert [e.type for e in events] == [EventType.STATE_SNAPSHOT]
        assert events[0].snapshot == {"count": 7, "name": "z"}
        assert new_state == {"count": 7, "name": "z"}

    @pytest.mark.asyncio
    async def test_state_updates_nested_json_string_value_reparsed(self):
        # Streaming re-parses a state_updates value that is itself a JSON string.
        # The non-streaming handler must do the same.
        block = ToolUseBlock(
            id="tc-nested",
            name=STATE_MANAGEMENT_TOOL_FULL_NAME,
            input={"state_updates": json.dumps({"count": 3})},
        )
        new_state, gen = await handle_tool_use_block(block, _Msg(), "th", "run", {"count": 1}, {})
        events = await collect(gen)
        assert events[0].snapshot == {"count": 3}
        assert new_state == {"count": 3}


class TestToolUseBlockParentMessageId:
    @pytest.mark.asyncio
    async def test_parent_message_id_uses_passed_assistant_message_id(self):
        # The streaming path sets ToolCallStartEvent.parent_message_id to the
        # current assistant message id. The non-streaming handler must mirror
        # that — NOT the SDK's parent_tool_use_id (which lives on the message).
        block = ToolUseBlock(id="tc1", name="get_weather", input={"city": "NYC"})
        msg = _Msg(parent_tool_use_id="SHOULD_NOT_BE_USED")
        _, gen = await handle_tool_use_block(block, msg, "th", "run", None, {}, parent_message_id="assistant-msg-1")
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
        events = await collect(handle_tool_result_block(block, "th", "run", {}))
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
        events = await collect(handle_tool_result_block(block, "th", "run", {}))
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
        events = await collect(handle_tool_result_block(block, "th", "run", {}))
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
        events = await collect(handle_tool_result_block(block, "th", "run", {}))
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
        events = await collect(handle_tool_result_block(block, "th", "run", {}))
        # Successful result is the bare payload, not wrapped in an error envelope.
        assert json.loads(events[0].content) == {"ok": True}

    @pytest.mark.asyncio
    async def test_does_not_emit_tool_call_end(self):
        # Regression guard: result handler must NOT re-emit TOOL_CALL_END
        # (that caused "No active tool call" runtime errors).
        block = ToolResultBlock(tool_use_id="tc1", content="plain")
        events = await collect(handle_tool_result_block(block, "th", "run", {}))
        assert all(e.type != EventType.TOOL_CALL_END for e in events)

    @pytest.mark.asyncio
    async def test_no_tool_use_id_emits_nothing(self):
        block = ToolResultBlock(tool_use_id="", content="x")
        events = await collect(handle_tool_result_block(block, "th", "run", {}))
        assert events == []

    # ── Item 5: tool-result content encoding consistency ──
    @pytest.mark.asyncio
    async def test_list_text_block_and_bare_string_encode_identically(self):
        # The SAME logical plain-text payload must reach the frontend with the
        # SAME encoding regardless of whether the SDK delivered it as a
        # list-of-text-blocks or as a bare string. Previously the list path
        # emitted the text UNQUOTED while the bare-string path json.dumps-quoted
        # it, so identical content arrived differently.
        list_block = ToolResultBlock(
            tool_use_id="tc1",
            content=[{"type": "text", "text": "plain text"}],
        )
        bare_block = ToolResultBlock(tool_use_id="tc2", content="plain text")
        list_events = await collect(handle_tool_result_block(list_block, "th", "run", {}))
        bare_events = await collect(handle_tool_result_block(bare_block, "th", "run", {}))
        assert list_events[0].content == bare_events[0].content

    # ── Item 9: untested fallback branches (non-list / scalar / except) ──
    @pytest.mark.asyncio
    async def test_dict_content_fallback_is_json_encoded(self):
        # content is a dict (not a list, not a string) -> json.dumps fallback.
        block = ToolResultBlock(tool_use_id="tc1", content={"k": "v"})
        events = await collect(handle_tool_result_block(block, "th", "run", {}))
        assert len(events) == 1
        assert json.loads(events[0].content) == {"k": "v"}

    @pytest.mark.asyncio
    async def test_scalar_int_content_fallback(self):
        # A bare non-string scalar -> json.dumps fallback.
        block = ToolResultBlock(tool_use_id="tc1", content=42)
        events = await collect(handle_tool_result_block(block, "th", "run", {}))
        assert len(events) == 1
        assert events[0].content == "42"

    @pytest.mark.asyncio
    async def test_empty_list_content_fallback(self):
        # An empty list takes the `else` (non-truthy-len) branch -> json.dumps([]).
        block = ToolResultBlock(tool_use_id="tc1", content=[])
        events = await collect(handle_tool_result_block(block, "th", "run", {}))
        assert len(events) == 1
        assert events[0].content == "[]"

    @pytest.mark.asyncio
    async def test_non_text_block_list_fallback(self):
        # A list whose first block is NOT a text block -> json.dumps(content).
        content = [{"type": "image", "data": "xyz"}]
        block = ToolResultBlock(tool_use_id="tc1", content=content)
        events = await collect(handle_tool_result_block(block, "th", "run", {}))
        assert len(events) == 1
        assert json.loads(events[0].content) == content

    @pytest.mark.asyncio
    async def test_unserializable_content_uses_str_fallback(self):
        # Content that json.dumps cannot serialise must hit the
        # `except (TypeError, ValueError) -> str(content)` fallback rather than
        # crashing the handler.
        class Unserializable:
            def __repr__(self):
                return "UNSER"

        block = ToolResultBlock(tool_use_id="tc1", content=Unserializable())
        events = await collect(handle_tool_result_block(block, "th", "run", {}))
        assert len(events) == 1
        assert events[0].content == "UNSER"


class TestNestedToolResult:
    # ── Item 8: parent_tool_use_id must be wired through ──
    @pytest.mark.asyncio
    async def test_parent_tool_use_id_surfaced_on_result(self):
        # A nested/sub-agent tool result carries a parent_tool_use_id. The
        # handler accepts it but historically never used it, so the documented
        # nested-result behavior was inert. It must now be surfaced on the
        # emitted event so consumers can attribute the result to its parent.
        block = ToolResultBlock(
            tool_use_id="child-tc",
            content=[{"type": "text", "text": '{"ok": true}'}],
        )
        events = await collect(
            handle_tool_result_block(block, "th", "run", {}, parent_tool_use_id="parent-tc")
        )
        assert len(events) == 1
        ev = events[0]
        # AG-UI's ToolCallResultEvent has no first-class parent field, so the
        # parent linkage is surfaced via the protocol-standard raw_event escape
        # hatch. Previously parent_tool_use_id was accepted but dropped.
        assert ev.raw_event is not None
        assert ev.raw_event.get("parent_tool_use_id") == "parent-tc"

    @pytest.mark.asyncio
    async def test_no_parent_tool_use_id_leaves_raw_event_unset(self):
        # Top-level (non-nested) results must NOT gain a spurious raw_event.
        block = ToolResultBlock(
            tool_use_id="tc1",
            content=[{"type": "text", "text": '{"ok": true}'}],
        )
        events = await collect(handle_tool_result_block(block, "th", "run", {}))
        assert len(events) == 1
        assert events[0].raw_event is None


class TestTaskSubagentActivity:
    """`Task` tool calls (Claude's native subagent orchestration) must surface
    as AG-UI activity events, not only as a generic tool call.

    The shape mirrors the Mastra integration's background-task activity
    (``MASTRA_BACKGROUND_TASK_ACTIVITY_TYPE`` in
    integrations/mastra/typescript/src/mastra.ts): one activity per task, the
    originating tool call id doubling as the activity ``message_id``, a
    camelCase ``content`` object opened at ``status: "running"``, and an
    RFC-6902 delta closing it at ``completed`` / ``failed``.

    The registry is per run, created by the adapter alongside
    ``processed_tool_ids`` and threaded in explicitly, so each test owns a
    fresh one and nothing survives between tests.
    """

    @pytest.fixture
    def registry(self):
        return {}

    @pytest.mark.asyncio
    async def test_task_tool_emits_activity_snapshot_alongside_tool_call(self, registry):
        block = ToolUseBlock(
            id="task-1",
            name="Task",
            input={
                "subagent_type": "code-reviewer",
                "description": "Review the diff",
                "prompt": "Review the diff and report findings",
            },
        )
        _, gen = await handle_tool_use_block(block, _Msg(), "th", "run", None, registry)
        events = await collect(gen)
        # The generic tool-call events still flow (the later TOOL_CALL_RESULT
        # addresses this call id), with the activity opened after the call is
        # closed — the same order Mastra uses when work continues as activity.
        assert [e.type for e in events] == [
            EventType.TOOL_CALL_START,
            EventType.TOOL_CALL_ARGS,
            EventType.TOOL_CALL_END,
            EventType.ACTIVITY_SNAPSHOT,
        ]
        snapshot = events[-1]
        assert snapshot.message_id == "task-1"
        assert snapshot.activity_type == SUBAGENT_TASK_ACTIVITY_TYPE
        assert snapshot.content == {
            "taskId": "task-1",
            "toolName": "Task",
            "toolCallId": "task-1",
            "status": "running",
            "subagentType": "code-reviewer",
            "description": "Review the diff",
            "prompt": "Review the diff and report findings",
            "outputs": [],
        }
        # The activity was recorded on the RUN's registry, not anywhere global.
        assert registry == {"task-1": SUBAGENT_TASK_ACTIVITY_TYPE}

    @pytest.mark.asyncio
    async def test_task_activity_omits_absent_optional_fields(self, registry):
        block = ToolUseBlock(id="task-2", name="Task", input={"prompt": "go"})
        _, gen = await handle_tool_use_block(block, _Msg(), "th", "run", None, registry)
        snapshot = (await collect(gen))[-1]
        assert snapshot.type == EventType.ACTIVITY_SNAPSHOT
        assert "subagentType" not in snapshot.content
        assert "description" not in snapshot.content
        assert snapshot.content["prompt"] == "go"

    @pytest.mark.asyncio
    async def test_non_task_tool_emits_no_activity(self, registry):
        block = ToolUseBlock(id="tc-plain", name="Bash", input={"command": "ls"})
        _, gen = await handle_tool_use_block(block, _Msg(), "th", "run", None, registry)
        types = [e.type for e in await collect(gen)]
        assert EventType.ACTIVITY_SNAPSHOT not in types
        assert registry == {}

    @pytest.mark.asyncio
    async def test_task_result_closes_activity_with_completed_delta(self, registry):
        use = ToolUseBlock(id="task-3", name="Task", input={"prompt": "go"})
        _, gen = await handle_tool_use_block(use, _Msg(), "th", "run", None, registry)
        await collect(gen)

        result = ToolResultBlock(
            tool_use_id="task-3",
            content=[{"type": "text", "text": '{"findings": 2}'}],
        )
        events = await collect(
            handle_tool_result_block(result, "th", "run", registry)
        )
        assert [e.type for e in events] == [
            EventType.TOOL_CALL_RESULT,
            EventType.ACTIVITY_DELTA,
        ]
        delta = events[-1]
        assert delta.message_id == "task-3"
        assert delta.activity_type == SUBAGENT_TASK_ACTIVITY_TYPE
        assert delta.patch == [
            {"op": "add", "path": "/status", "value": "completed"},
            {"op": "add", "path": "/result", "value": {"findings": 2}},
        ]
        # Closing the activity clears it from the run's registry.
        assert registry == {}

    @pytest.mark.asyncio
    async def test_failed_task_result_closes_activity_as_failed(self, registry):
        use = ToolUseBlock(id="task-4", name="Task", input={"prompt": "go"})
        _, gen = await handle_tool_use_block(use, _Msg(), "th", "run", None, registry)
        await collect(gen)

        result = ToolResultBlock(
            tool_use_id="task-4", content="subagent exploded", is_error=True
        )
        events = await collect(
            handle_tool_result_block(result, "th", "run", registry)
        )
        assert [e.type for e in events] == [
            EventType.TOOL_CALL_RESULT,
            EventType.ACTIVITY_DELTA,
        ]
        delta = events[-1]
        assert delta.patch[0] == {"op": "add", "path": "/status", "value": "failed"}
        assert delta.patch[1]["path"] == "/error"
        assert "subagent exploded" in json.dumps(delta.patch[1]["value"])

    @pytest.mark.asyncio
    async def test_activity_closed_once_so_a_repeat_result_emits_no_delta(self, registry):
        use = ToolUseBlock(id="task-5", name="Task", input={"prompt": "go"})
        _, gen = await handle_tool_use_block(use, _Msg(), "th", "run", None, registry)
        await collect(gen)
        result = ToolResultBlock(
            tool_use_id="task-5", content=[{"type": "text", "text": "done"}]
        )
        first = await collect(
            handle_tool_result_block(result, "th", "run", registry)
        )
        assert EventType.ACTIVITY_DELTA in [e.type for e in first]
        second = await collect(
            handle_tool_result_block(result, "th", "run", registry)
        )
        assert EventType.ACTIVITY_DELTA not in [e.type for e in second]

    @pytest.mark.asyncio
    async def test_result_for_unopened_activity_emits_no_delta(self, registry):
        result = ToolResultBlock(
            tool_use_id="never-opened", content=[{"type": "text", "text": "hi"}]
        )
        events = await collect(
            handle_tool_result_block(result, "th", "run", registry)
        )
        assert [e.type for e in events] == [EventType.TOOL_CALL_RESULT]

    @pytest.mark.asyncio
    async def test_same_tool_call_id_opens_the_activity_only_once(self, registry):
        # Both adapter paths call open_task_activity. An id seen by both must
        # open exactly one activity, so the single closing delta is never left
        # addressing a second, still-open snapshot.
        block = ToolUseBlock(id="task-6", name="Task", input={"prompt": "go"})
        _, first = await handle_tool_use_block(block, _Msg(), "th", "run", None, registry)
        assert EventType.ACTIVITY_SNAPSHOT in [e.type for e in await collect(first)]
        _, second = await handle_tool_use_block(block, _Msg(), "th", "run", None, registry)
        assert EventType.ACTIVITY_SNAPSHOT not in [e.type for e in await collect(second)]

    @pytest.mark.asyncio
    async def test_separate_registries_do_not_share_activities(self, registry):
        # Two runs, two registries. A result delivered to the OTHER run must not
        # close an activity that this run opened — which is exactly what a
        # process-wide registry would have allowed.
        other_registry = {}
        use = ToolUseBlock(id="task-7", name="Task", input={"prompt": "go"})
        _, gen = await handle_tool_use_block(use, _Msg(), "th-a", "run-a", None, registry)
        await collect(gen)
        assert "task-7" in registry
        assert other_registry == {}

        result = ToolResultBlock(
            tool_use_id="task-7", content=[{"type": "text", "text": "done"}]
        )
        foreign = await collect(
            handle_tool_result_block(result, "th-b", "run-b", other_registry)
        )
        assert [e.type for e in foreign] == [EventType.TOOL_CALL_RESULT]
        # The owning run still holds its activity and can still close it.
        assert "task-7" in registry
        own = await collect(
            handle_tool_result_block(result, "th-a", "run-a", registry)
        )
        assert EventType.ACTIVITY_DELTA in [e.type for e in own]

    @pytest.mark.asyncio
    async def test_registry_is_required_on_both_handlers(self):
        # The registry is a required parameter, not an optional one. A caller
        # that forgets it fails immediately and visibly, instead of opening an
        # activity nothing can ever close and leaving the UI showing a subagent
        # stuck at "running" for good.
        block = ToolUseBlock(id="task-9", name="Task", input={"prompt": "go"})
        with pytest.raises(TypeError):
            await handle_tool_use_block(block, _Msg(), "th", "run", None)
        result = ToolResultBlock(
            tool_use_id="task-9", content=[{"type": "text", "text": "done"}]
        )
        with pytest.raises(TypeError):
            await collect(handle_tool_result_block(result, "th", "run"))

    @pytest.mark.asyncio
    async def test_public_constant_is_exported_for_renderers(self):
        # A frontend registers its subagent renderer against this string, so it
        # must be importable from the package rather than hardcoded.
        import ag_ui_claude_sdk

        assert ag_ui_claude_sdk.SUBAGENT_TASK_ACTIVITY_TYPE == SUBAGENT_TASK_ACTIVITY_TYPE
        assert "SUBAGENT_TASK_ACTIVITY_TYPE" in ag_ui_claude_sdk.__all__
