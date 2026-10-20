"""Unified runtime checkpoints, including SDK-migrated saves."""

from types import SimpleNamespace

import pytest
from strands.interrupt import _InterruptState

from ag_ui_strands.interrupt_checkpoint import (
    UNREADABLE_CHECKPOINT,
    parked_assistant_message,
    parked_tool_results,
    publish_parked_tool_results,
)


def test_old_runtime_layout_is_unreadable_instead_of_resumed():
    state = SimpleNamespace(context={"tool_use_message": {"role": "assistant"}})
    assert parked_assistant_message(state) is UNREADABLE_CHECKPOINT


def test_missing_persistence_setter_fails_instead_of_losing_the_correction():
    state = SimpleNamespace(
        pending_tool_execution=SimpleNamespace(completed_tool_results=[])
    )
    with pytest.raises(AttributeError):
        publish_parked_tool_results(state, [])


def test_sdk_restores_legacy_saved_batch_and_persists_corrected_results():
    message = {
        "role": "assistant",
        "content": [
            {"toolUse": {"toolUseId": "client", "name": "weather", "input": {}}}
        ],
    }
    saved = {
        "activated": True,
        "interrupts": {},
        "context": {
            "tool_use_message": message,
            "tool_results": [
                {
                    "toolUseId": "client",
                    "status": "success",
                    "content": [{"text": "Forwarded to client"}],
                }
            ],
        },
    }
    state = _InterruptState.from_dict(saved)
    assert parked_assistant_message(state) == message
    results = parked_tool_results(state)
    results[0]["content"] = [{"text": "sunny"}]
    publish_parked_tool_results(state, results)
    restored = _InterruptState.from_dict(state.to_dict())
    assert parked_tool_results(restored)[0]["content"] == [{"text": "sunny"}]
    assert "tool_results" not in restored.context
