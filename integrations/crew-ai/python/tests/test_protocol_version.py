"""RUN_STARTED declares the AG-UI protocol version (PNI-524).

AG-UI 1.0 lets a producer state the protocol version it speaks on
``RUN_STARTED.protocolVersion``. Every site that builds a ``RunStartedEvent``
must set it from ``ag_ui.core.PROTOCOL_VERSION``:

* ``StreamFrameTranslator`` on ``flow_started`` (the StreamFrame path);
* ``StreamFrameTranslator.ensure_run_started`` (resume / forced open);
* the legacy bus listener's ``FlowStartedEvent`` handler in ``endpoint.py``.

The wire tests decode the SSE the real drivers write, so they fail if the
field is dropped by stamping or serialization, not only at construction.
No network.
"""

import asyncio
import json
import time
from types import SimpleNamespace

from ag_ui.core import PROTOCOL_VERSION, EventType, RunAgentInput
from ag_ui.encoder import EventEncoder
from ag_ui_crewai import endpoint as ep
from ag_ui_crewai._capabilities import crewai_event_bus
from ag_ui_crewai._frames import StreamFrameTranslator
from ag_ui_crewai.context import flow_context
from crewai.flow.flow import Flow, start

from .conftest import requires_stream_frames


def _translator():
    return StreamFrameTranslator(
        thread_id="t-1", run_id="r-1", state_provider=dict
    )


def _assert_declares_version(event):
    assert event.type == EventType.RUN_STARTED
    assert event.protocol_version == PROTOCOL_VERSION
    wire = json.loads(event.model_dump_json(by_alias=True, exclude_none=True))
    assert wire["protocolVersion"] == "1.0"


def test_protocol_version_constant_is_1_0():
    # Pins the SDK floor: the assertions below compare against the constant,
    # so a wrong installed SDK would otherwise pass silently.
    assert PROTOCOL_VERSION == "1.0"


def test_translator_flow_started_declares_protocol_version():
    events = _translator().translate(SimpleNamespace(type="flow_started"))
    assert len(events) == 1
    _assert_declares_version(events[0])


def test_translator_ensure_run_started_declares_protocol_version():
    events = _translator().ensure_run_started()
    assert len(events) == 1
    _assert_declares_version(events[0])


class _FakeFlow:
    """Minimal Flow stand-in the legacy listener can attach a queue to."""

    def __init__(self):
        self.state = {"messages": []}


async def test_legacy_listener_run_started_declares_protocol_version():
    from crewai.events.types.flow_events import FlowStartedEvent

    flow = _FakeFlow()
    queue = await ep.create_queue(flow)
    token = flow_context.set(flow)
    try:
        ep.FastAPICrewFlowEventListener()  # registers handlers on the global bus
        crewai_event_bus.emit(
            flow, FlowStartedEvent.model_construct(flow_name="F", inputs=None)
        )
        flush = getattr(crewai_event_bus, "flush", None)
        deadline = time.monotonic() + 3.0
        while queue.empty() and time.monotonic() < deadline:
            if callable(flush):
                flush(5.0)
            await asyncio.sleep(0.02)
    finally:
        flow_context.reset(token)
        await ep.delete_queue(flow)

    started = []
    while not queue.empty():
        item = queue.get_nowait()
        if item is not None and item.type == EventType.RUN_STARTED:
            started.append(item)
    assert len(started) == 1
    _assert_declares_version(started[0])


class _QuietFlow(Flow):
    @start()
    async def chat(self):
        return "done"


@requires_stream_frames
async def test_frame_path_wire_run_started_declares_protocol_version():
    input_data = RunAgentInput(
        thread_id="t-1", run_id="r-1", state={}, messages=[], tools=[],
        context=[], forwarded_props={},
    )
    payloads = []
    async for chunk in ep._run_flow_frame_stream(
        flow_copy=_QuietFlow(),
        encoder=EventEncoder(),
        input_data=input_data,
        inputs={"id": "t-1"},
        timeout=30.0,
    ):
        for line in chunk.splitlines():
            if line.startswith("data:"):
                payloads.append(json.loads(line[len("data:"):].strip()))

    assert payloads[0]["type"] == "RUN_STARTED"
    assert payloads[0]["protocolVersion"] == "1.0"
    assert payloads[0]["threadId"] == "t-1"
