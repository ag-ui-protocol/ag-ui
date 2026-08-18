import json
import math
from dataclasses import is_dataclass
from typing import get_type_hints

import pytest

from ag_ui_strands.frontend_tool_wait import (
    FRONTEND_TOOL_RESPONSE_KEY,
    FRONTEND_TOOL_WAIT_INTERRUPT_NAME,
    FrontendToolWaitBatch,
    FrontendToolWaitCall,
    classify_frontend_tool_wait_reason,
    frontend_tool_wait_reason,
    is_frontend_wait_interrupt,
    parse_frontend_wait_interrupt,
    MAX_COMPLETED_WIRE_IDS,
    try_unwrap_frontend_tool_response,
    unwrap_frontend_tool_response,
    wrap_frontend_tool_response,
)


def _call(
    wire_id: str,
    *,
    interrupt_id: str | None = None,
    content: str = "",
    is_error: bool = False,
    has_response: bool = False,
    end_handed_off: bool | None = None,
) -> FrontendToolWaitCall:
    return FrontendToolWaitCall(
        interrupt_id or f"interrupt-{wire_id}",
        f"native-{wire_id}",
        wire_id,
        content,
        is_error,
        has_response,
        has_response if end_handed_off is None else end_handed_off,
    )


def test_wrap_and_strict_unwrap_preserve_every_string_in_a_truthy_envelope():
    for content in ("", "0", '{"ok": false}'):
        wrapped = wrap_frontend_tool_response(content, is_error=True)
        assert wrapped == {
            FRONTEND_TOOL_RESPONSE_KEY: {"content": content, "is_error": True}
        }
        assert bool(wrapped) is True
        assert unwrap_frontend_tool_response(wrapped) == (content, True)
    with pytest.raises(ValueError, match="envelope"):
        unwrap_frontend_tool_response({FRONTEND_TOOL_RESPONSE_KEY: "x", "extra": 1})
    with pytest.raises(ValueError, match="content"):
        unwrap_frontend_tool_response(
            {FRONTEND_TOOL_RESPONSE_KEY: {"content": 0, "is_error": False}}
        )
    with pytest.raises(ValueError, match="is_error"):
        unwrap_frontend_tool_response(
            {FRONTEND_TOOL_RESPONSE_KEY: {"content": "x", "is_error": 0}}
        )
    assert try_unwrap_frontend_tool_response({"bad": "shape"}) is None


def test_strict_unwrap_return_annotation_is_not_optional():
    assert get_type_hints(unwrap_frontend_tool_response)["return"] == tuple[str, bool]


def test_tagged_reason_is_classified_without_confusing_other_reasons():
    reason = frontend_tool_wait_reason(native_tool_use_id="native-1")
    assert reason == {
        "name": FRONTEND_TOOL_WAIT_INTERRUPT_NAME,
        "native_tool_use_id": "native-1",
    }
    assert classify_frontend_tool_wait_reason(reason) is True
    assert is_frontend_wait_interrupt(reason) is True
    assert parse_frontend_wait_interrupt(reason) == "native-1"
    assert classify_frontend_tool_wait_reason({"name": "other"}) is False
    assert is_frontend_wait_interrupt({"name": "other"}) is False


def test_wait_batch_retains_dataclass_contract_with_private_immutable_state():
    assert is_dataclass(FrontendToolWaitBatch)
    assert FrontendToolWaitBatch().calls == ()


@pytest.mark.parametrize("native_tool_use_id", ["", 0, None])
def test_frontend_wait_reason_rejects_empty_or_non_string_native_ids(
    native_tool_use_id,
):
    with pytest.raises((TypeError, ValueError)):
        frontend_tool_wait_reason(native_tool_use_id=native_tool_use_id)


def test_frontend_wait_reason_strictly_rejects_malformed_tagged_data():
    with pytest.raises(ValueError, match="native"):
        parse_frontend_wait_interrupt(
            {"name": FRONTEND_TOOL_WAIT_INTERRUPT_NAME, "native_tool_use_id": ""}
        )
    with pytest.raises(ValueError, match="malformed"):
        is_frontend_wait_interrupt(
            {
                "name": FRONTEND_TOOL_WAIT_INTERRUPT_NAME,
                "native_tool_use_id": "native",
                "extra": True,
            }
        )


def test_call_requires_all_identities_and_round_trips_explicit_response_presence():
    call = _call("wire-1", content="", has_response=True)
    assert json.loads(json.dumps(call.to_dict())) == {
        "interrupt_id": "interrupt-wire-1",
        "native_tool_use_id": "native-wire-1",
        "wire_tool_call_id": "wire-1",
        "content": "",
        "is_error": False,
        "has_response": True,
        "end_handed_off": True,
    }
    assert FrontendToolWaitCall.from_dict(call.to_dict()) == call
    with pytest.raises(ValueError):
        FrontendToolWaitCall.from_dict(
            {
                "interrupt_id": "i",
                "native_tool_use_id": "n",
                "content": "",
                "has_response": False,
            }
        )


def test_persisted_batch_rejects_every_missing_or_extra_required_field():
    data = FrontendToolWaitBatch(calls=[_call("a")]).to_dict()
    for field_name in tuple(data):
        malformed = dict(data)
        malformed.pop(field_name)
        with pytest.raises(ValueError, match="batch"):
            FrontendToolWaitBatch.from_dict(malformed)

    with pytest.raises(ValueError, match="batch"):
        FrontendToolWaitBatch.from_dict({**data, "extra": True})


def test_persisted_call_requires_handoff_field_and_response_acknowledges_end():
    data = {
        "interrupt_id": "interrupt-a",
        "native_tool_use_id": "native-a",
        "wire_tool_call_id": "a",
        "content": "answer",
        "is_error": False,
        "has_response": True,
        "end_handed_off": True,
    }
    restored = FrontendToolWaitCall.from_dict(data)
    assert restored.end_handed_off is True
    assert restored.to_dict() == data

    for field_name in tuple(data):
        malformed = dict(data)
        malformed.pop(field_name)
        with pytest.raises(ValueError, match="call"):
            FrontendToolWaitCall.from_dict(malformed)
    with pytest.raises(ValueError, match="call"):
        FrontendToolWaitCall.from_dict({**data, "extra": True})
    with pytest.raises(ValueError, match="handed off"):
        FrontendToolWaitCall.from_dict({**data, "end_handed_off": False})


def test_handoff_apis_are_immutable_ordered_and_response_is_acknowledgement():
    batch = FrontendToolWaitBatch(calls=[_call("a"), _call("b"), _call("c")])
    assert [call.wire_tool_call_id for call in batch.unhanded_calls] == [
        "a",
        "b",
        "c",
    ]

    marked = batch.mark_end_handed_off("b")
    assert [call.wire_tool_call_id for call in marked.unhanded_calls] == ["a", "c"]
    assert [call.end_handed_off for call in batch.calls] == [False, False, False]
    with pytest.raises(ValueError, match="unknown"):
        batch.mark_end_handed_off("missing")

    acknowledged = marked.stage_responses([{"tool_call_id": "a", "content": "answer"}])
    assert acknowledged.calls[0].has_response is True
    assert acknowledged.calls[0].end_handed_off is True
    assert [call.wire_tool_call_id for call in acknowledged.unhanded_calls] == ["c"]


def test_checkpoint_halt_is_strictly_persisted_across_batch_transitions_and_reset_on_consumption():
    batch = FrontendToolWaitBatch(
        calls=[_call("a")],
        stop_streaming_after_result=True,
    )

    serialized = batch.to_dict()
    assert serialized["stop_streaming_after_result"] is True
    restored = FrontendToolWaitBatch.from_dict(serialized)
    assert restored.stop_streaming_after_result is True
    assert restored.mark_end_handed_off("a").stop_streaming_after_result is True

    complete = restored.stage_responses([{"tool_call_id": "a", "content": "answer"}])
    assert complete.stop_streaming_after_result is True
    assert complete.mark_consumed().stop_streaming_after_result is False

    serialized["stop_streaming_after_result"] = 1
    with pytest.raises(ValueError, match="boolean"):
        FrontendToolWaitBatch.from_dict(serialized)


def test_stage_by_wire_id_is_first_wins_and_does_not_mutate_calls_or_input():
    batch = FrontendToolWaitBatch(calls=[_call("a"), _call("b")])
    assert batch.call_for_wire_id("a") == _call("a")
    assert batch.call_for_wire_id("missing") is None
    incoming = [
        {"tool_call_id": "a", "content": '{"done": false}'},
        {"tool_call_id": "a", "content": "later"},
    ]
    staged = batch.stage_responses(incoming)
    assert batch.calls[0].has_response is False
    assert incoming[0]["content"] == '{"done": false}'
    assert staged.calls[0].content == '{"done": false}'
    assert staged.calls[0].has_response is True


def test_responses_reject_partial_batch_and_return_non_mutating_snapshots_when_complete():
    partial = FrontendToolWaitBatch(
        calls=[_call("a", content="x", has_response=True), _call("b")]
    )
    with pytest.raises(ValueError, match="partial"):
        partial.responses()
    complete = partial.stage_responses([{"tool_call_id": "b", "content": ""}])
    snapshots = complete.responses()
    assert snapshots == {
        "interrupt-a": wrap_frontend_tool_response("x", is_error=False),
        "interrupt-b": wrap_frontend_tool_response("", is_error=False),
    }
    assert all(bool(response) for response in snapshots.values())
    assert unwrap_frontend_tool_response(snapshots["interrupt-b"]) == ("", False)
    snapshots["interrupt-a"][FRONTEND_TOOL_RESPONSE_KEY]["content"] = "changed"
    assert complete.calls[0].content == "x"


def test_mark_consumed_clears_calls_and_replaces_only_bounded_wire_id_tombstones():
    batch = FrontendToolWaitBatch(calls=[_call("a"), _call("b")])
    complete = batch.stage_responses(
        [{"tool_call_id": "a", "content": ""}, {"tool_call_id": "b", "content": ""}]
    )
    consumed = complete.mark_consumed(["old", "older"])
    assert consumed.calls == ()
    assert consumed.last_completed_wire_ids == ("a", "b")
    assert all(isinstance(wire_id, str) for wire_id in consumed.last_completed_wire_ids)


@pytest.mark.parametrize(
    "bad",
    [
        {"nested": {1: "bad"}},
        {"nested": {"set": {"bad"}}},
        {"nested": math.nan},
        object(),
    ],
)
def test_serialization_and_load_reject_non_json_safe_nested_state(bad):
    with pytest.raises(ValueError):
        FrontendToolWaitCall("i", "n", "w", bad, False).to_dict()
    state = _call("a").to_dict()
    state["content"] = bad
    with pytest.raises(ValueError):
        FrontendToolWaitCall.from_dict(state)


def test_load_rejects_malformed_batch_and_non_string_content():
    with pytest.raises(ValueError):
        FrontendToolWaitBatch.from_dict(
            {"calls": [], "last_completed_wire_ids": ["ok", 1]}
        )
    with pytest.raises(ValueError):
        FrontendToolWaitCall.from_dict(
            {
                "interrupt_id": "i",
                "native_tool_use_id": "n",
                "wire_tool_call_id": "w",
                "content": [],
                "has_response": False,
            }
        )


def test_batch_rejects_duplicate_interrupt_ids_during_construction_and_load():
    with pytest.raises(ValueError, match="interrupt"):
        FrontendToolWaitBatch(
            calls=[_call("a", interrupt_id="same"), _call("b", interrupt_id="same")]
        )
    state = FrontendToolWaitBatch(calls=[_call("a"), _call("b")]).to_dict()
    state["calls"][1]["interrupt_id"] = state["calls"][0]["interrupt_id"]
    with pytest.raises(ValueError, match="interrupt"):
        FrontendToolWaitBatch.from_dict(state)


def test_constructors_defensively_copy_and_validate_every_id_domain():
    calls = [_call("a")]
    tombstones = ["old"]
    batch = FrontendToolWaitBatch(calls=calls, last_completed_wire_ids=tombstones)
    calls.clear()
    tombstones.append("changed")
    assert len(batch.calls) == 1
    assert batch.last_completed_wire_ids == ("old",)
    with pytest.raises(AttributeError):
        batch.calls.append(_call("b"))
    for duplicate in ("interrupt_id", "native_tool_use_id", "wire_tool_call_id"):
        first, second = _call("a"), _call("b")
        second = FrontendToolWaitCall(
            first.interrupt_id if duplicate == "interrupt_id" else second.interrupt_id,
            first.native_tool_use_id
            if duplicate == "native_tool_use_id"
            else second.native_tool_use_id,
            first.wire_tool_call_id
            if duplicate == "wire_tool_call_id"
            else second.wire_tool_call_id,
        )
        with pytest.raises(ValueError, match="duplicate"):
            FrontendToolWaitBatch(calls=[first, second])
    with pytest.raises(ValueError):
        FrontendToolWaitCall("", "native", "wire")
    with pytest.raises(ValueError):
        FrontendToolWaitCall("interrupt", "native", "wire", "", "not-bool")


def test_tombstone_bounds_roundtrip_and_partial_consumption_are_strict():
    assert (
        len(
            FrontendToolWaitBatch(
                last_completed_wire_ids=[
                    str(i) for i in range(MAX_COMPLETED_WIRE_IDS - 1)
                ]
            ).last_completed_wire_ids
        )
        == MAX_COMPLETED_WIRE_IDS - 1
    )
    maximum = FrontendToolWaitBatch(
        last_completed_wire_ids=[str(i) for i in range(MAX_COMPLETED_WIRE_IDS)]
    )
    assert (
        FrontendToolWaitBatch.from_dict(json.loads(json.dumps(maximum.to_dict())))
        == maximum
    )
    with pytest.raises(ValueError, match="completed"):
        FrontendToolWaitBatch(
            last_completed_wire_ids=[str(i) for i in range(MAX_COMPLETED_WIRE_IDS + 1)]
        )
    with pytest.raises(ValueError, match="partial"):
        FrontendToolWaitBatch(calls=[_call("a")]).mark_consumed()
