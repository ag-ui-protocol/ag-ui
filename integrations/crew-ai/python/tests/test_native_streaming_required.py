"""Native transport contract and isolation regression tests (PNI-561)."""
import json

import pytest
from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from ag_ui_crewai import endpoint as ep


def decode(events):
    return [json.loads(line[6:]) for event in events for line in event.splitlines() if line.startswith("data: ")]


async def test_kickoff_only_flow_is_rejected_without_running():
    class CustomFlow:
        async def kickoff_async(self, inputs=None):
            pytest.fail("A kickoff-only flow must never use a fallback transport")

    events = decode([event async for event in ep._run_flow_stream(
        flow_copy=CustomFlow(), encoder=EventEncoder(),
        input_data=RunAgentInput(thread_id="t", run_id="r", state={}, messages=[], tools=[], context=[], forwarded_props={}),
        inputs={}, timeout=1,
    )])
    assert len(events) == 1
    assert events[0]["type"] == "RUN_ERROR"
    assert events[0]["code"] == "AGUI_CREWAI_NATIVE_STREAMING_REQUIRED"
    assert "astream" in events[0]["message"]
    assert events[0]["threadId"] == "t"
    assert events[0]["runId"] == "r"


async def test_concurrent_native_runs_keep_state_and_protocol_declarations_isolated():
    import asyncio
    from crewai.flow.flow import Flow, start
    from ag_ui_crewai.sdk import copilotkit_emit_state

    arrived = 0
    both_running = asyncio.Event()

    class ConcurrentFlow(Flow[dict]):
        @start()
        async def emit_owner(self):
            nonlocal arrived
            arrived += 1
            if arrived == 2:
                both_running.set()
            await both_running.wait()
            await copilotkit_emit_state({"owner": self.state["owner"]})

    template = ConcurrentFlow()

    async def run(owner):
        flow = ep._copy_flow(template)
        request = RunAgentInput(thread_id=owner, run_id=f"run-{owner}", state={}, messages=[], tools=[], context=[], forwarded_props={})
        return decode([event async for event in ep._run_flow_stream(
            flow_copy=flow, encoder=EventEncoder(), input_data=request,
            inputs={"owner": owner}, timeout=5,
        )])

    runs = await asyncio.wait_for(asyncio.gather(run("alice"), run("bob")), 10)
    for owner, events in zip(("alice", "bob"), runs):
        starts = [event for event in events if event["type"] == "RUN_STARTED"]
        assert len(starts) == 1
        assert starts[0]["protocolVersion"] == "1.0"
        assert starts[0]["threadId"] == owner
        snapshots = [event["snapshot"] for event in events if event["type"] == "STATE_SNAPSHOT"]
        assert {snapshot["owner"] for snapshot in snapshots} == {owner}
        assert events[-1]["type"] == "RUN_FINISHED"
    assert "owner" not in template.state


@pytest.mark.parametrize("resumed", [False, True], ids=["kickoff", "resume"])
@pytest.mark.parametrize("termination", ["close", "cancel", "timeout"])
async def test_native_session_owns_cancellation(resumed, termination):
    import asyncio
    from crewai.types.streaming import AsyncStreamSession
    from crewai.utilities.streaming import create_async_frame_generator, create_frame_streaming_state
    from ag_ui_crewai.context import flow_context
    from ag_ui_crewai._capabilities import crewai_event_bus, FlowStartedEvent

    started = asyncio.Event()
    cancelled = asyncio.Event()
    first_event = asyncio.Event()

    class NativeFlow:
        state = {}

        async def resume_async(self, feedback):
            await self.run()

        async def run(self):
            try:
                started.set()
                crewai_event_bus.emit(self, FlowStartedEvent(flow_name="NativeFlow"))
                from ag_ui_crewai.sdk import copilotkit_emit_state
                await copilotkit_emit_state({"started": True})
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        def astream(self, inputs):
            output = []
            session = AsyncStreamSession(async_iterator=create_async_frame_generator(
                create_frame_streaming_state([], use_async=True), self.run, output,
            ))
            output.append(session)
            return session

    flow = NativeFlow()
    request = RunAgentInput(thread_id="t", run_id="r", state={}, messages=[], tools=[], context=[], forwarded_props={})
    stream = ep._run_flow_frame_stream(
        flow_copy=flow, encoder=EventEncoder(), input_data=request, inputs={},
        timeout=0.05 if termination == "timeout" else 5,
        resume_feedback="ok" if resumed else None,
    )
    events = []
    prior_context = flow_context.get(None)

    async def consume():
        try:
            async for event in stream:
                events.append(event)
                first_event.set()
                if termination == "close" and started.is_set():
                    break
        finally:
            await stream.aclose()
        assert flow_context.get(None) is prior_context

    task = asyncio.create_task(consume())
    await asyncio.wait_for(started.wait(), 2)
    if termination == "cancel":
        await asyncio.wait_for(first_event.wait(), 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        await asyncio.wait_for(task, 2)
    await asyncio.wait_for(cancelled.wait(), 2)
    payloads = decode(events)
    assert payloads[0]["protocolVersion"] == "1.0"
    if termination == "timeout":
        assert payloads[-1]["code"] == "AGUI_CREWAI_FLOW_TIMEOUT"
    assert flow_context.get(None) is prior_context


async def test_resume_preserves_requested_chunk_shape_and_protocol_version():
    from ag_ui_crewai._capabilities import crewai_event_bus
    from ag_ui_crewai.events import BridgedTextMessageChunkEvent

    class PendingFlow:
        state = {}

        @classmethod
        def from_pending(cls, thread_id):
            return cls()

        async def resume_async(self, feedback):
            assert feedback == "approved"
            crewai_event_bus.emit(self, BridgedTextMessageChunkEvent(
                type="TEXT_MESSAGE_CHUNK", message_id="answer", role="assistant", delta="resumed",
            ))

    request = RunAgentInput(thread_id="t", run_id="r", state={}, messages=[], tools=[], context=[], forwarded_props={}, resume=[{"interruptId": "t", "status": "resolved", "payload": "approved"}])
    events = decode([event async for event in ep._run_flow_resume_stream(
        flow=PendingFlow(), encoder=EventEncoder(), input_data=request,
        timeout=5, emission_shape="chunks",
    )])
    assert events[0]["protocolVersion"] == "1.0"
    assert [event["delta"] for event in events if event["type"] == "TEXT_MESSAGE_CHUNK"] == ["resumed"]
    assert not any(event["type"] == "TEXT_MESSAGE_CONTENT" for event in events)
    assert events[-1]["type"] == "RUN_FINISHED"
