"""Scoped StreamFrame translator harness for SDK emission unit tests.

Full session/endpoint tests live in test_streaming and test_interrupts. This
harness isolates translation without a flow executor or global bus listeners.
"""
import asyncio
from ag_ui_crewai._capabilities import add_stream_sink, reset_stream_sinks
from ag_ui_crewai._frames import StreamFrameTranslator, capture_method_emit_context

async def capture_events(flow):
    translator = StreamFrameTranslator(thread_id="test", run_id="test", state_provider=lambda: flow.state, flow_provider=lambda: flow, emission_shape="chunks")
    translator.ensure_run_started()
    queue = asyncio.Queue()
    def sink(source, event):
        if source is flow:
            capture_method_emit_context(event, flow)
            for translated in translator.translate(event):
                queue.put_nowait(translated)
    token = add_stream_sink(sink)
    object.__setattr__(flow, "_test_capture", (queue, token))
    return queue

def captured_events(flow):
    capture = getattr(flow, "_test_capture", None)
    return capture[0] if capture else None

async def close_capture(flow):
    capture = getattr(flow, "_test_capture", None)
    if capture:
        reset_stream_sinks(capture[1])
        object.__delattr__(flow, "_test_capture")
