"""The starter is a canonical AG-UI 1.0 producer."""

import json
import unittest

from fastapi import Request

from ag_ui.core import PROTOCOL_VERSION, RunAgentInput
from example_server import agentic_chat_endpoint


def _request() -> Request:
    return Request({"type": "http", "headers": [(b"accept", b"text/event-stream")]})


def _input() -> RunAgentInput:
    return RunAgentInput(
        thread_id="t1",
        run_id="r1",
        state={},
        messages=[],
        tools=[],
        context=[],
        forwarded_props={},
    )


async def _events() -> list:
    response = await agentic_chat_endpoint(_input(), _request())
    return [json.loads(chunk[len("data: "):]) async for chunk in response.body_iterator]


class ProtocolVersionTest(unittest.IsolatedAsyncioTestCase):
    async def test_run_started_declares_protocol_version(self):
        events = await _events()
        self.assertEqual(events[0]["type"], "RUN_STARTED")
        self.assertEqual(events[0]["protocolVersion"], PROTOCOL_VERSION)

    async def test_run_finished_omits_absent_result(self):
        events = await _events()
        self.assertEqual(events[-1]["type"], "RUN_FINISHED")
        self.assertNotIn("result", events[-1])


if __name__ == "__main__":
    unittest.main()
