#!/usr/bin/env python
"""End-to-end tests for multimodal message support in ADK middleware.

These tests verify that multimodal content (images, audio, video, documents)
is correctly converted and sent to Google Gemini models via the ADK middleware.

Tests in this module require GOOGLE_API_KEY to be set.
They make real API calls to Google Gemini and are skipped otherwise.
"""

import base64
import io
import os
import struct
import zlib
from typing import List

import pytest

from ag_ui.core import (
    BaseEvent,
    EventType,
    ImageInputContent,
    InputContentDataSource,
    InputContentUrlSource,
    RunAgentInput,
    TextInputContent,
    UserMessage,
)
from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents import LlmAgent

# Skip the entire module when there is no API key.
pytestmark = pytest.mark.skipif(
    not os.environ.get("GOOGLE_API_KEY"),
    reason="GOOGLE_API_KEY environment variable not set",
)

DEFAULT_MODEL = "gemini-2.0-flash"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def collect_events(agent: ADKAgent, run_input: RunAgentInput) -> List[BaseEvent]:
    """Collect all events from running an agent."""
    events = []
    async for event in agent.run(run_input):
        events.append(event)
    return events


def get_event_types(events: List[BaseEvent]) -> List[str]:
    return [str(e.type) for e in events]


def extract_text_message(events: List[BaseEvent]) -> str:
    """Concatenate all TEXT_MESSAGE_CONTENT deltas from the event stream."""
    parts = []
    for e in events:
        if str(e.type) == "EventType.TEXT_MESSAGE_CONTENT":
            parts.append(e.delta)
    return "".join(parts)


def make_solid_color_png(r: int, g: int, b: int, width: int = 2, height: int = 2) -> bytes:
    """Create a minimal valid PNG image of a solid colour.

    Returns raw PNG bytes (not base64-encoded).
    """

    def _chunk(chunk_type: bytes, data: bytes) -> bytes:
        c = chunk_type + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    header = b"\x89PNG\r\n\x1a\n"
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    ihdr = _chunk(b"IHDR", ihdr_data)

    # Build raw scanlines: filter byte (0) + RGB pixels per row
    raw = b""
    for _ in range(height):
        raw += b"\x00" + bytes([r, g, b]) * width
    idat = _chunk(b"IDAT", zlib.compress(raw))
    iend = _chunk(b"IEND", b"")

    return header + ihdr + idat + iend


# ---------------------------------------------------------------------------
# Pre-built test images
# ---------------------------------------------------------------------------

RED_PNG_BYTES = make_solid_color_png(255, 0, 0)
RED_PNG_B64 = base64.b64encode(RED_PNG_BYTES).decode("ascii")

BLUE_PNG_BYTES = make_solid_color_png(0, 0, 255)
BLUE_PNG_B64 = base64.b64encode(BLUE_PNG_BYTES).decode("ascii")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestMultimodalE2E:
    """E2E tests that send multimodal content to a live Gemini model."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    def _make_agent(self, instruction: str) -> ADKAgent:
        llm_agent = LlmAgent(
            name="multimodal_test_agent",
            model=DEFAULT_MODEL,
            instruction=instruction,
        )
        return ADKAgent(
            adk_agent=llm_agent,
            app_name="multimodal_test_app",
            user_id="test_user",
            use_in_memory_services=True,
        )

    # ---- Inline base64 image tests ----------------------------------------

    @pytest.mark.asyncio
    async def test_image_inline_data_produces_description(self):
        """Send a solid-red PNG via inline base64 and verify the model describes it."""
        agent = self._make_agent(
            "You are an image analysis assistant. "
            "When the user sends an image, describe its dominant colour in one word. "
            "Reply ONLY with the colour name, nothing else."
        )

        run_input = RunAgentInput(
            thread_id="e2e_img_inline_1",
            run_id="run_1",
            messages=[
                UserMessage(
                    id="msg_1",
                    role="user",
                    content=[
                        TextInputContent(text="What colour is this image?"),
                        ImageInputContent(
                            source=InputContentDataSource(
                                value=RED_PNG_B64,
                                mime_type="image/png",
                            ),
                        ),
                    ],
                ),
            ],
            state={},
            tools=[],
            forwarded_props={},
        )

        events = await collect_events(agent, run_input)
        event_types = get_event_types(events)

        assert "EventType.RUN_STARTED" in event_types
        assert "EventType.RUN_FINISHED" in event_types
        assert "EventType.RUN_ERROR" not in event_types

        response = extract_text_message(events).lower()
        assert "red" in response, f"Expected 'red' in model response, got: {response!r}"

        await agent.close()

    @pytest.mark.asyncio
    async def test_two_inline_images_compared(self):
        """Send two different coloured images and ask the model to compare them."""
        agent = self._make_agent(
            "You are an image comparison assistant. "
            "The user will send two images. State the dominant colour of each, "
            "in order, separated by a comma. Example: 'red, blue'. "
            "Reply ONLY with the two colour names, nothing else."
        )

        run_input = RunAgentInput(
            thread_id="e2e_img_compare",
            run_id="run_1",
            messages=[
                UserMessage(
                    id="msg_1",
                    role="user",
                    content=[
                        TextInputContent(text="What are the colours of these two images?"),
                        ImageInputContent(
                            source=InputContentDataSource(
                                value=RED_PNG_B64,
                                mime_type="image/png",
                            ),
                        ),
                        ImageInputContent(
                            source=InputContentDataSource(
                                value=BLUE_PNG_B64,
                                mime_type="image/png",
                            ),
                        ),
                    ],
                ),
            ],
            state={},
            tools=[],
            forwarded_props={},
        )

        events = await collect_events(agent, run_input)
        event_types = get_event_types(events)

        assert "EventType.RUN_STARTED" in event_types
        assert "EventType.RUN_FINISHED" in event_types
        assert "EventType.RUN_ERROR" not in event_types

        response = extract_text_message(events).lower()
        assert "red" in response, f"Expected 'red' in model response, got: {response!r}"
        assert "blue" in response, f"Expected 'blue' in model response, got: {response!r}"

        await agent.close()

    # ---- URL-based image tests --------------------------------------------

    @pytest.mark.asyncio
    async def test_image_url_source_produces_description(self):
        """Send an image via public URL and verify the model can describe it.

        Uses a well-known Wikimedia Commons image of a red apple on a white
        background (public domain).
        """
        agent = self._make_agent(
            "You are an image analysis assistant. "
            "Describe the main subject of the image in one or two words. "
            "Reply ONLY with the subject description, nothing else."
        )

        run_input = RunAgentInput(
            thread_id="e2e_img_url_1",
            run_id="run_1",
            messages=[
                UserMessage(
                    id="msg_1",
                    role="user",
                    content=[
                        TextInputContent(text="What is the main subject of this image?"),
                        ImageInputContent(
                            source=InputContentUrlSource(
                                value="https://upload.wikimedia.org/wikipedia/commons/thumb/1/15/Red_Apple.jpg/800px-Red_Apple.jpg",
                                mime_type="image/jpeg",
                            ),
                        ),
                    ],
                ),
            ],
            state={},
            tools=[],
            forwarded_props={},
        )

        events = await collect_events(agent, run_input)
        event_types = get_event_types(events)

        assert "EventType.RUN_STARTED" in event_types
        assert "EventType.RUN_FINISHED" in event_types
        assert "EventType.RUN_ERROR" not in event_types

        response = extract_text_message(events).lower()
        assert "apple" in response, f"Expected 'apple' in model response, got: {response!r}"

        await agent.close()

    # ---- Mixed content tests ----------------------------------------------

    @pytest.mark.asyncio
    async def test_mixed_text_and_inline_image(self):
        """Verify the model receives both text and image context together."""
        agent = self._make_agent(
            "You are a helpful assistant. "
            "The user will ask a question and provide an image. "
            "Answer the question about the image. Be concise."
        )

        run_input = RunAgentInput(
            thread_id="e2e_mixed_1",
            run_id="run_1",
            messages=[
                UserMessage(
                    id="msg_1",
                    role="user",
                    content=[
                        TextInputContent(
                            text="Is this image predominantly a warm colour or a cool colour? "
                            "Answer with just 'warm' or 'cool'."
                        ),
                        ImageInputContent(
                            source=InputContentDataSource(
                                value=RED_PNG_B64,
                                mime_type="image/png",
                            ),
                        ),
                    ],
                ),
            ],
            state={},
            tools=[],
            forwarded_props={},
        )

        events = await collect_events(agent, run_input)
        event_types = get_event_types(events)

        assert "EventType.RUN_STARTED" in event_types
        assert "EventType.RUN_FINISHED" in event_types
        assert "EventType.RUN_ERROR" not in event_types

        response = extract_text_message(events).lower()
        assert "warm" in response, f"Expected 'warm' in model response, got: {response!r}"

        await agent.close()
