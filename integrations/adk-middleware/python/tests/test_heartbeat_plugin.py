#!/usr/bin/env python
"""Tests for HeartbeatPlugin and its per-request event-queue plumbing."""

import asyncio
from types import SimpleNamespace

import pytest

from ag_ui.core import ActivitySnapshotEvent, EventType
from ag_ui_adk.heartbeat import (
    HeartbeatPlugin,
    set_event_queue,
    get_event_queue,
    reset_event_queue,
    emit_progress,
)


def _make_tool(name="web_scraper"):
    return SimpleNamespace(name=name)


def _make_ctx(function_call_id="call_1"):
    return SimpleNamespace(function_call_id=function_call_id)


def _drain(queue):
    events = []
    while True:
        try:
            events.append(queue.get_nowait())
        except asyncio.QueueEmpty:
            return events


def test_interval_validation():
    """A non-positive interval is rejected at construction."""
    with pytest.raises(ValueError):
        HeartbeatPlugin(interval_seconds=0)
    with pytest.raises(ValueError):
        HeartbeatPlugin(interval_seconds=-1.0)
    # A valid interval constructs fine.
    assert HeartbeatPlugin(interval_seconds=0.5).interval_seconds == 0.5


def test_contextvar_set_and_reset():
    q = asyncio.Queue()
    assert get_event_queue() is None
    token = set_event_queue(q)
    assert get_event_queue() is q
    reset_event_queue(token)
    assert get_event_queue() is None


async def test_emit_progress_is_noop_without_queue():
    """emit_progress is a safe no-op (returns False) when no queue is bound."""
    assert get_event_queue() is None
    assert await emit_progress("TOOL_EXECUTION", "starting", "tool") is False


async def test_emitted_event_is_a_valid_activity_snapshot():
    """The emitted event is a schema-valid ACTIVITY_SNAPSHOT carrying progress
    info in `content`."""
    q = asyncio.Queue()
    token = set_event_queue(q)
    try:
        assert await emit_progress(
            "TOOL_EXECUTION", "processing", "web_scraper",
            elapsed_seconds=25.04, heartbeat=5,
        ) is True
    finally:
        reset_event_queue(token)

    (event,) = _drain(q)
    assert isinstance(event, ActivitySnapshotEvent)
    assert event.type == EventType.ACTIVITY_SNAPSHOT
    assert event.activity_type == "TOOL_EXECUTION"
    assert event.replace is True
    assert event.content["status"] == "processing"
    assert event.content["tool_name"] == "web_scraper"
    assert event.content["heartbeat"] == 5
    assert event.content["elapsed_seconds"] == 25.0  # rounded to 1dp
    # Re-validate against the model to guard the content shape.
    ActivitySnapshotEvent.model_validate(event.model_dump())


async def test_before_tool_emits_starting_event():
    plugin = HeartbeatPlugin(interval_seconds=10.0)  # long: no processing beat
    q = asyncio.Queue()
    token = set_event_queue(q)
    try:
        await plugin.before_tool_callback(
            tool=_make_tool(), tool_args={}, tool_context=_make_ctx()
        )
        # Stop the beat task immediately so it doesn't linger.
        await plugin.after_tool_callback(
            tool=_make_tool(), tool_args={}, tool_context=_make_ctx(), result={}
        )
    finally:
        reset_event_queue(token)

    statuses = [e.content["status"] for e in _drain(q)]
    assert statuses[0] == "starting"
    assert "complete" in statuses


async def test_before_tool_is_noop_without_queue():
    """With no stream bound, the plugin does nothing and starts no beat task."""
    plugin = HeartbeatPlugin(interval_seconds=0.01)
    result = await plugin.before_tool_callback(
        tool=_make_tool(), tool_args={}, tool_context=_make_ctx()
    )
    assert result is None
    assert plugin._tasks == {}


async def test_heartbeats_emit_at_interval_then_stop_on_completion():
    plugin = HeartbeatPlugin(interval_seconds=0.05)
    q = asyncio.Queue()
    token = set_event_queue(q)
    try:
        await plugin.before_tool_callback(
            tool=_make_tool(), tool_args={}, tool_context=_make_ctx()
        )
        await asyncio.sleep(0.17)  # ~3 intervals
        await plugin.after_tool_callback(
            tool=_make_tool(), tool_args={}, tool_context=_make_ctx(), result={}
        )
        # The beat task must be gone once the tool finished.
        assert plugin._tasks == {}

        events = _drain(q)
        processing = [e for e in events if e.content["status"] == "processing"]
        assert len(processing) >= 2
        # Heartbeat counter increments and elapsed time is non-decreasing.
        assert [e.content["heartbeat"] for e in processing] == sorted(
            e.content["heartbeat"] for e in processing
        )
        elapsed = [e.content["elapsed_seconds"] for e in processing]
        assert elapsed == sorted(elapsed)
        assert events[-1].content["status"] == "complete"

        # No further heartbeats after completion.
        await asyncio.sleep(0.12)
        assert not any(e.content["status"] == "processing" for e in _drain(q))
    finally:
        reset_event_queue(token)


async def test_error_path_emits_error_status_and_stops():
    plugin = HeartbeatPlugin(interval_seconds=0.05)
    q = asyncio.Queue()
    token = set_event_queue(q)
    try:
        await plugin.before_tool_callback(
            tool=_make_tool(), tool_args={}, tool_context=_make_ctx()
        )
        await asyncio.sleep(0.07)
        await plugin.on_tool_error_callback(
            tool=_make_tool(), tool_args={}, tool_context=_make_ctx(),
            error=RuntimeError("boom"),
        )
        assert plugin._tasks == {}
        statuses = [e.content["status"] for e in _drain(q)]
        assert statuses[-1] == "error"
    finally:
        reset_event_queue(token)


async def test_concurrent_requests_are_isolated():
    """A shared plugin instance keeps two concurrent runs' heartbeats on their
    own queues (per-task ContextVar + per-call-id task tracking)."""
    plugin = HeartbeatPlugin(interval_seconds=0.05)

    async def run(tool_name, call_id):
        q = asyncio.Queue()
        token = set_event_queue(q)
        try:
            await plugin.before_tool_callback(
                tool=_make_tool(tool_name), tool_args={}, tool_context=_make_ctx(call_id)
            )
            await asyncio.sleep(0.13)
            await plugin.after_tool_callback(
                tool=_make_tool(tool_name), tool_args={}, tool_context=_make_ctx(call_id),
                result={},
            )
            return _drain(q)
        finally:
            reset_event_queue(token)

    a_events, b_events = await asyncio.gather(
        run("scraper_a", "call_a"),
        run("scraper_b", "call_b"),
    )

    assert a_events and b_events
    assert {e.content["tool_name"] for e in a_events} == {"scraper_a"}
    assert {e.content["tool_name"] for e in b_events} == {"scraper_b"}
    assert plugin._tasks == {}
