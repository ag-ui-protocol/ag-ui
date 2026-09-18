"""Language-neutral fixtures shared with the native TypeScript integration."""

import json
from collections import Counter
from pathlib import Path

import pytest

from ag_ui_copilot_sdk import EventMapper

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "contract.json"
CONTRACT = json.loads(FIXTURES.read_text())
CASES = CONTRACT["cases"]


def joined(events, kind):
    messages = {}
    for event in events:
        if event["type"] == kind:
            key = event["messageId"]
            messages[key] = messages.get(key, "") + event["delta"]
    return list(messages.values())


def assert_lifecycle(events):
    open_blocks = set()
    started_blocks = set()
    block_owners = {}
    tool_starts, tool_ends = set(), set()
    tool_owners = {}
    active_children, finished_children = set(), set()
    block_types = {
        "TEXT_MESSAGE_START": ("text", "start"),
        "TEXT_MESSAGE_CONTENT": ("text", "content"),
        "TEXT_MESSAGE_END": ("text", "end"),
        "REASONING_START": ("phase", "start"),
        "REASONING_END": ("phase", "end"),
        "REASONING_MESSAGE_START": ("reasoning", "start"),
        "REASONING_MESSAGE_CONTENT": ("reasoning", "content"),
        "REASONING_MESSAGE_END": ("reasoning", "end"),
    }
    for event in events:
        kind = event["type"]
        owner = event.get("subagentRunId")
        assert kind != "RAW"
        if kind in block_types:
            assert owner is None or owner in active_children
            family, action = block_types[kind]
            key = (family, event["messageId"])
            if action == "start":
                assert key not in started_blocks
                started_blocks.add(key)
                open_blocks.add(key)
                block_owners[key] = owner
            else:
                assert key in open_blocks
                assert block_owners[key] == owner
                if action == "end":
                    open_blocks.remove(key)
        elif kind == "TOOL_CALL_START":
            assert owner is None or owner in active_children
            assert event["toolCallId"] not in tool_starts
            tool_starts.add(event["toolCallId"])
            tool_owners[event["toolCallId"]] = owner
        elif kind in ("TOOL_CALL_ARGS", "TOOL_CALL_END"):
            call_id = event["toolCallId"]
            assert call_id in tool_starts and call_id not in tool_ends
            assert tool_owners[call_id] == owner
            assert owner is None or owner in active_children
            if kind == "TOOL_CALL_END":
                tool_ends.add(call_id)
        elif kind == "TOOL_CALL_RESULT":
            # A result mints its own message; its executor can differ from the caller.
            assert owner is None or owner in active_children
        elif kind == "SUBAGENT_STARTED":
            identity = event["subagentRunId"]
            assert identity not in active_children | finished_children
            if event.get("parentSubagentRunId"):
                assert event["parentSubagentRunId"] in active_children
            active_children.add(identity)
        elif kind in ("SUBAGENT_FINISHED", "SUBAGENT_ERROR"):
            identity = event["subagentRunId"]
            assert identity in active_children
            assert not any(block_owners[key] == identity for key in open_blocks)
            assert not any(tool_owners[key] == identity for key in tool_starts - tool_ends)
            active_children.remove(identity)
            finished_children.add(identity)
    assert not open_blocks
    assert tool_starts == tool_ends
    assert not active_children


@pytest.mark.parametrize("fault", ["late-close", "wrong-owner"])
def test_lifecycle_rejects_child_reasoning_boundary_faults(fault):
    events = [
        {"type": "SUBAGENT_STARTED", "subagentRunId": "child"},
        {"type": "REASONING_START", "messageId": "r", "subagentRunId": "child"},
        {"type": "REASONING_MESSAGE_START", "messageId": "r", "subagentRunId": "child"},
    ]
    if fault == "late-close":
        events.append({"type": "SUBAGENT_FINISHED", "subagentRunId": "child"})
    else:
        events.append({"type": "REASONING_MESSAGE_END", "messageId": "r"})
    with pytest.raises(AssertionError):
        assert_lifecycle(events)


@pytest.mark.parametrize("owner", [None, "child"])
def test_lifecycle_accepts_tool_result_creation_without_a_tool_opener(owner):
    events = []
    if owner:
        events.append({"type": "SUBAGENT_STARTED", "subagentRunId": owner})
    events.append({
        "type": "TOOL_CALL_RESULT", "messageId": "result", "toolCallId": "earlier-call",
        "content": "actual result", **({"subagentRunId": owner} if owner else {}),
    })
    if owner:
        events.append({"type": "SUBAGENT_FINISHED", "subagentRunId": owner})
    assert_lifecycle(events)


def test_lifecycle_still_rejects_an_unannounced_child_result():
    with pytest.raises(AssertionError):
        assert_lifecycle([{
            "type": "TOOL_CALL_RESULT", "messageId": "result", "toolCallId": "call",
            "content": "actual child result", "subagentRunId": "unannounced",
        }])


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_shared_contract(case):
    mapper = EventMapper()
    if "error" in case["expect"]:
        emitted = []
        with pytest.raises(ValueError, match=case["expect"]["error"]):
            for raw in case["events"]:
                emitted.extend(mapper.map_event({**CONTRACT.get("envelopeDefaults", {}), **raw}))
        assert emitted == []
        return
    typed = [
        mapped
        for raw in case["events"]
        for mapped in mapper.map_event({**CONTRACT.get("envelopeDefaults", {}), **raw})
    ]
    typed.extend(mapper.finish())
    events = [event.model_dump(mode="json", by_alias=True, exclude_none=True) for event in typed]
    assert_lifecycle(events)
    expected = case["expect"]
    counts = Counter(event["type"] for event in events)
    if "text" in expected:
        assert joined(events, "TEXT_MESSAGE_CONTENT") == expected["text"]
    if "reasoning" in expected:
        assert joined(events, "REASONING_MESSAGE_CONTENT") == expected["reasoning"]
    if "types" in expected:
        assert [event["type"] for event in events] == expected["types"]
    for kind, count in expected.get("counts", {}).items():
        assert counts[kind] == count
    if "toolArguments" in expected:
        by_call = {}
        for event in events:
            if event["type"] == "TOOL_CALL_ARGS":
                key = event["toolCallId"]
                by_call[key] = by_call.get(key, "") + event["delta"]
        assert [json.loads(value) for value in by_call.values()] == expected["toolArguments"]
    results = [event["content"] for event in events if event["type"] == "TOOL_CALL_RESULT"]
    if "toolResults" in expected:
        assert results == expected["toolResults"]
    for text in expected.get("toolResultContains", []):
        assert any(text in result for result in results)
    if "activityOutputs" in expected:
        assert [
            event["content"]["output"]
            for event in events
            if event["type"] == "ACTIVITY_SNAPSHOT"
            and event.get("activityType") == "copilot-sdk:tool"
        ] == expected["activityOutputs"]
    if "lastToolActivity" in expected:
        last = [
            event["content"]
            for event in events
            if event["type"] == "ACTIVITY_SNAPSHOT"
            and event.get("activityType") == "copilot-sdk:tool"
        ][-1]
        for key, value in expected["lastToolActivity"].items():
            assert last[key] == value
    if "distinctTextMessageIds" in expected:
        assert (
            len({event["messageId"] for event in events if event["type"] == "TEXT_MESSAGE_START"})
            == expected["distinctTextMessageIds"]
        )
    for forbidden in expected.get("forbidden", []):
        assert forbidden not in json.dumps(events)
