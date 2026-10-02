"""Every example is a canonical AG-UI 1.0 producer."""

import json
import unittest

from fastapi import Request

from ag_ui.core import (
    PROTOCOL_VERSION,
    ImagePart,
    RunAgentInput,
    TextPart,
    UrlSource,
    UserMessage,
)
from example_server.agentic_chat import agentic_chat_endpoint
from example_server.agentic_generative_ui import agentic_generative_ui_endpoint
from example_server.backend_tool_rendering import backend_tool_rendering_endpoint
from example_server.content import message_text
from example_server.human_in_the_loop import human_in_the_loop_endpoint
from example_server.predictive_state_updates import predictive_state_updates_endpoint
from example_server.shared_state import shared_state_endpoint
from example_server.tool_based_generative_ui import tool_based_generative_ui_endpoint

ENDPOINTS = [
    agentic_chat_endpoint,
    agentic_generative_ui_endpoint,
    backend_tool_rendering_endpoint,
    human_in_the_loop_endpoint,
    predictive_state_updates_endpoint,
    shared_state_endpoint,
    tool_based_generative_ui_endpoint,
]

IMAGE = ImagePart(type="image", source=UrlSource(type="url", value="https://example.com/a.png"))


def _request() -> Request:
    return Request({"type": "http", "headers": [(b"accept", b"text/event-stream")]})


def _input(content="hi") -> RunAgentInput:
    return RunAgentInput(
        thread_id="t1",
        run_id="r1",
        state={},
        messages=[UserMessage(id="m1", role="user", content=content)],
        tools=[],
        context=[],
        forwarded_props={},
    )


def _decode(chunk: str) -> dict:
    return json.loads(chunk[len("data: "):])


async def _first_event(response) -> dict:
    async for chunk in response.body_iterator:
        return _decode(chunk)


async def _events(response) -> list:
    return [_decode(chunk) async for chunk in response.body_iterator]


class RunStartedTest(unittest.IsolatedAsyncioTestCase):
    async def test_every_example_declares_protocol_version(self):
        for endpoint in ENDPOINTS:
            with self.subTest(endpoint=endpoint.__name__):
                event = await _first_event(await endpoint(_input(), _request()))
                self.assertEqual(event["type"], "RUN_STARTED")
                self.assertEqual(event["protocolVersion"], PROTOCOL_VERSION)


class ContentPartsTest(unittest.IsolatedAsyncioTestCase):
    def test_message_text_reads_a_string(self):
        message = UserMessage(id="m", role="user", content="tool")
        self.assertEqual(message_text(message), "tool")

    def test_message_text_joins_text_parts(self):
        parts = [TextPart(type="text", text="a"), TextPart(type="text", text="b")]
        message = UserMessage(id="m", role="user", content=parts)
        self.assertEqual(message_text(message), "a\nb")

    def test_message_text_skips_media_with_a_warning(self):
        parts = [IMAGE, TextPart(type="text", text="tool")]
        message = UserMessage(id="m", role="user", content=parts)
        with self.assertLogs("example_server.content", level="WARNING"):
            self.assertEqual(message_text(message), "tool")

    async def test_agentic_chat_routes_on_text_parts(self):
        content = [IMAGE, TextPart(type="text", text="tool")]
        events = await _events(await agentic_chat_endpoint(_input(content), _request()))
        self.assertIn("TOOL_CALL_START", [event["type"] for event in events])

    async def test_tool_based_generative_ui_routes_on_text_parts(self):
        content = [TextPart(type="text", text="thanks")]
        response = await tool_based_generative_ui_endpoint(_input(content), _request())
        events = await _events(response)
        snapshot = next(e for e in events if e["type"] == "MESSAGES_SNAPSHOT")
        self.assertEqual(snapshot["messages"][-1]["content"], "Haiku created")
        self.assertNotIn("toolCalls", snapshot["messages"][-1])


if __name__ == "__main__":
    unittest.main()
