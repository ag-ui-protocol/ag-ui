"""Regression coverage for ag-ui-protocol/ag-ui#1279 and #1582.

The protocol-level ``run_id`` arriving on ``RunAgentInput.run_id`` is the
identity of an AG-UI run. ``RUN_STARTED`` and ``RUN_FINISHED`` framing
events MUST carry that exact id so a downstream protocol state machine
(e.g. ``@copilotkit/runtime``) can correlate stream open/close.

Historically, ``_handle_stream_events`` overwrote ``self.active_run["id"]``
with each LangGraph stream event's ``run_id`` (LangGraph's internal
UUIDv7 chain id), so ``RUN_FINISHED`` emitted a different ``runId`` than
``RUN_STARTED``. The visible symptom downstream is::

    Cannot send 'RUN_STARTED' while a run is still active. The previous
    run must be finished with 'RUN_FINISHED' before starting a new run.

— surfaced as a ``RUN_ERROR`` with ``code: INCOMPLETE_STREAM`` on the
client.

This test pins the contract directly: feed a stream whose events carry
LangGraph's internal (string) ``run_id`` and assert the dispatched
``RUN_STARTED`` and ``RUN_FINISHED`` framing both equal
``input.run_id``.
"""

import unittest
from unittest.mock import AsyncMock, MagicMock

from ag_ui.core import EventType

from tests._helpers import make_agent, _record_dispatch


PROTOCOL_RUN_ID = "c0609373-b2ad-40f8-9d8a-9b21d1efb7fa"  # client UUIDv4
LANGGRAPH_INTERNAL_RUN_ID = "019cd777-880c-7152-aaaa-bbbbccccdddd"  # UUIDv7 shape


class TestProtocolRunIdSurvivesStreamEvents(unittest.IsolatedAsyncioTestCase):
    """RUN_STARTED and RUN_FINISHED must both carry ``input.run_id``,
    even when intermediate stream events surface LangGraph's own
    (string) chain ``run_id``."""

    async def test_run_started_and_finished_use_protocol_run_id(self):
        agent = make_agent()
        _record_dispatch(agent)

        async def fake_prepare(*args, **kwargs):
            agent.active_run["schema_keys"] = {
                "input": ["messages"], "output": ["messages"],
                "config": [], "context": [],
            }

            async def gen():
                # A perfectly-valid LangGraph stream event whose run_id
                # is a string — but a *different* string from the
                # protocol run_id. This is the realistic shape; the bug
                # only manifests when the overwrite path silently
                # succeeds (string-typed event run_id), not when it
                # rejects (non-string).
                yield {
                    "event": "on_chain_start",
                    "run_id": LANGGRAPH_INTERNAL_RUN_ID,
                    "name": "node_a",
                    "data": {},
                    "metadata": {"langgraph_node": "node_a"},
                }
                yield {
                    "event": "on_chain_end",
                    "run_id": LANGGRAPH_INTERNAL_RUN_ID,
                    "name": "node_a",
                    "data": {"output": {}},
                    "metadata": {"langgraph_node": "node_a"},
                }

            return {
                "stream": gen(),
                "state": MagicMock(values={"messages": []}),
                "config": {"configurable": {"thread_id": "t1"}},
            }

        agent.prepare_stream = fake_prepare
        final_state = MagicMock()
        final_state.values = {"messages": []}
        final_state.tasks = []
        final_state.next = []
        final_state.metadata = {"writes": {}}
        agent.graph.aget_state = AsyncMock(return_value=final_state)

        run_input = MagicMock()
        run_input.run_id = PROTOCOL_RUN_ID
        run_input.thread_id = "t1"
        run_input.forwarded_props = {}

        async for _ in agent._handle_stream_events(run_input):
            pass

        started = [e for e in agent.dispatched
                   if getattr(e, "type", None) == EventType.RUN_STARTED]
        finished = [e for e in agent.dispatched
                    if getattr(e, "type", None) == EventType.RUN_FINISHED]

        self.assertEqual(len(started), 1, "expected exactly one RUN_STARTED")
        self.assertEqual(len(finished), 1, "expected exactly one RUN_FINISHED")
        self.assertEqual(
            started[0].run_id,
            PROTOCOL_RUN_ID,
            "RUN_STARTED should carry the client-supplied protocol run_id",
        )
        self.assertEqual(
            finished[0].run_id,
            PROTOCOL_RUN_ID,
            "RUN_FINISHED should carry the client-supplied protocol run_id "
            "— LangGraph's internal chain run_id leaked through the framing",
        )
        # Belt-and-suspenders: the started/finished pair must match each
        # other. This is what the downstream protocol state machine
        # actually checks.
        self.assertEqual(started[0].run_id, finished[0].run_id)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
