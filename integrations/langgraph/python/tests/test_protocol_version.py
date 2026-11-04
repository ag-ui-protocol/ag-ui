"""RUN_STARTED declares the protocol version when the installed SDK has one.

ag-ui-protocol 1.0 exports ``PROTOCOL_VERSION`` and gives ``RunStartedEvent``
a ``protocol_version`` field. The declared floor (0.1.x) has neither, and its
models accept extra fields, so passing the field there would put a snake_case
``protocol_version`` key on the wire. These tests pin both behaviours: the
1.0 branch runs in the locked lane, the floor branch in the
``langgraph-python-declared-floor`` lane.
"""

import json
import unittest

import ag_ui.core as agui_core
from ag_ui.core import EventType, RunAgentInput, RunStartedEvent, UserMessage
from ag_ui.encoder import EventEncoder
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph

from ag_ui_langgraph import agent as agent_module
from ag_ui_langgraph.agent import LangGraphAgent

SDK_PROTOCOL_VERSION = getattr(agui_core, "PROTOCOL_VERSION", None)


def _make_agent(node=None):
    graph = StateGraph(MessagesState)
    graph.add_node("noop", node or (lambda state: {}))
    graph.add_edge(START, "noop")
    graph.add_edge("noop", END)
    return LangGraphAgent(name="versioned", graph=graph.compile(checkpointer=MemorySaver()))


def _input():
    return RunAgentInput(
        thread_id="thread-version",
        run_id="run-version",
        state={},
        tools=[],
        context=[],
        forwarded_props={},
        messages=[UserMessage(id="u1", role="user", content="hi")],
    )


def _wire(event):
    """Decode the SSE frame the encoder would send for ``event``."""
    frame = EventEncoder().encode(event)
    assert frame.startswith("data: "), frame
    return json.loads(frame[len("data: "):])


async def _run_started(agent):
    events = [event async for event in agent.run(_input())]
    started = [e for e in events if e.type == EventType.RUN_STARTED]
    assert len(started) == 1, [e.type for e in events]
    return started[0]


class TestProtocolVersionDetection(unittest.TestCase):
    def test_agent_uses_the_installed_sdk_constant(self):
        self.assertEqual(agent_module.PROTOCOL_VERSION, SDK_PROTOCOL_VERSION)


@unittest.skipIf(SDK_PROTOCOL_VERSION is None, "installed ag-ui-protocol predates PROTOCOL_VERSION")
class TestProtocolVersionOnSdk10(unittest.IsolatedAsyncioTestCase):
    async def test_run_started_declares_protocol_version(self):
        started = await _run_started(_make_agent())
        self.assertEqual(started.protocol_version, "1.0")
        wire = _wire(started)
        self.assertEqual(wire["protocolVersion"], "1.0")
        self.assertNotIn("protocol_version", wire)

    async def test_error_path_run_started_declares_protocol_version(self):
        # A failure before the stream's own RUN_STARTED makes run() synthesize
        # one; it must declare the version too.
        agent = _make_agent()

        async def failing_prepare_stream(*args, **kwargs):
            raise RuntimeError("prepare failed")

        agent.prepare_stream = failing_prepare_stream
        events = [event async for event in agent.run(_input())]
        self.assertEqual([e.type for e in events], [EventType.RUN_STARTED, EventType.RUN_ERROR])
        self.assertEqual(_wire(events[0])["protocolVersion"], "1.0")


@unittest.skipIf(SDK_PROTOCOL_VERSION is not None, "installed ag-ui-protocol exports PROTOCOL_VERSION")
class TestProtocolVersionOnFloorSdk(unittest.IsolatedAsyncioTestCase):
    async def test_run_started_omits_protocol_version_and_stays_valid(self):
        started = await _run_started(_make_agent())
        wire = _wire(started)
        self.assertNotIn("protocolVersion", wire)
        self.assertNotIn("protocol_version", wire)
        self.assertEqual(wire["type"], "RUN_STARTED")
        self.assertEqual(wire["threadId"], "thread-version")
        self.assertEqual(wire["runId"], "run-version")
        # Round-trips through the floor SDK's own model.
        RunStartedEvent.model_validate(wire)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
