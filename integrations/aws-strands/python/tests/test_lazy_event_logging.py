"""Regression tests for lazy formatting of Strands stream events."""

import logging

import pytest
from ag_ui.core import EventType

from .test_reasoning_events import create_agent_with_mock_events, make_input_data


class ReprSentinel:
    """Count formatting without constructing an expensive representation."""

    def __init__(self):
        self.repr_calls = 0

    def __repr__(self):
        self.repr_calls += 1
        return "<event-payload>"


@pytest.mark.asyncio
@pytest.mark.parametrize("level", [logging.INFO, logging.DEBUG])
@pytest.mark.parametrize("event_key", ["init_event_loop", "result"])
async def test_event_repr_is_lazy(caplog, level, event_key):
    sentinel = ReprSentinel()
    stream_event = {event_key: sentinel}
    agent = create_agent_with_mock_events([stream_event])

    with caplog.at_level(level, logger="ag_ui_strands.agent"):
        events = [event async for event in agent.run(make_input_data())]

    assert events[-1].type == EventType.RUN_FINISHED
    if level == logging.DEBUG:
        assert sentinel.repr_calls > 0
        assert any(
            record.name == "ag_ui_strands.agent"
            and record.getMessage() == f"Received event: {{'{event_key}': <event-payload>}}"
            for record in caplog.records
        )
    else:
        assert sentinel.repr_calls == 0
        assert not any(
            record.msg == "Received event: %s" for record in caplog.records
        )
