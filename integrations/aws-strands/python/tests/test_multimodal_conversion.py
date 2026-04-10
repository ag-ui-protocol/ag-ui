"""Tests for AG-UI to Strands multimodal content conversion utilities."""

from __future__ import annotations

import base64
from unittest.mock import MagicMock, patch

import pytest
from ag_ui.core import (
    TextInputContent,
    ImageInputContent,
    AudioInputContent,
    VideoInputContent,
    DocumentInputContent,
    InputContentDataSource,
    InputContentUrlSource,
)

from ag_ui_strands.utils import (
    convert_agui_content_to_strands,
    flatten_content_to_text,
    _mime_to_format,
)


# ---------------------------------------------------------------------------
# convert_agui_content_to_strands
# ---------------------------------------------------------------------------


class TestConvertAguiContentToStrands:
    """Tests for convert_agui_content_to_strands."""

    def test_text_only_content(self):
        content = [TextInputContent(text="Hello world")]
        result = convert_agui_content_to_strands(content)
        assert result == [{"text": "Hello world"}]

    def test_multiple_text_blocks(self):
        content = [
            TextInputContent(text="Hello"),
            TextInputContent(text="World"),
        ]
        result = convert_agui_content_to_strands(content)
        assert len(result) == 2
        assert result[0] == {"text": "Hello"}
        assert result[1] == {"text": "World"}

    def test_image_with_data_source(self):
        raw_bytes = b"fake-png-image-data"
        b64_value = base64.b64encode(raw_bytes).decode()
        source = InputContentDataSource(value=b64_value, mime_type="image/png")
        content = [ImageInputContent(source=source)]

        result = convert_agui_content_to_strands(content)

        assert len(result) == 1
        assert "image" in result[0]
        assert result[0]["image"]["format"] == "png"
        assert result[0]["image"]["source"]["bytes"] == raw_bytes

    def test_image_with_jpeg_mime(self):
        raw_bytes = b"fake-jpeg-image-data"
        b64_value = base64.b64encode(raw_bytes).decode()
        source = InputContentDataSource(value=b64_value, mime_type="image/jpeg")
        content = [ImageInputContent(source=source)]

        result = convert_agui_content_to_strands(content)

        assert len(result) == 1
        assert result[0]["image"]["format"] == "jpeg"
        assert result[0]["image"]["source"]["bytes"] == raw_bytes

    @patch("ag_ui_strands.utils._fetch_url_bytes")
    def test_image_with_url_source(self, mock_fetch):
        fetched_bytes = b"fetched-image-bytes"
        mock_fetch.return_value = fetched_bytes
        source = InputContentUrlSource(value="https://example.com/img.png", mime_type="image/png")
        content = [ImageInputContent(source=source)]

        result = convert_agui_content_to_strands(content)

        mock_fetch.assert_called_once_with("https://example.com/img.png")
        assert len(result) == 1
        assert result[0]["image"]["format"] == "png"
        assert result[0]["image"]["source"]["bytes"] == fetched_bytes

    @patch("ag_ui_strands.utils._fetch_url_bytes")
    def test_image_url_fetch_failure_skips_block(self, mock_fetch):
        mock_fetch.return_value = None
        source = InputContentUrlSource(value="https://example.com/broken.png", mime_type="image/png")
        content = [ImageInputContent(source=source)]

        result = convert_agui_content_to_strands(content)

        assert result == []

    def test_mixed_text_and_image(self):
        raw_bytes = b"image-data"
        b64_value = base64.b64encode(raw_bytes).decode()
        source = InputContentDataSource(value=b64_value, mime_type="image/png")
        content = [
            TextInputContent(text="Look at this:"),
            ImageInputContent(source=source),
        ]

        result = convert_agui_content_to_strands(content)

        assert len(result) == 2
        assert result[0] == {"text": "Look at this:"}
        assert "image" in result[1]
        assert result[1]["image"]["format"] == "png"

    def test_document_with_data_source(self):
        raw_bytes = b"fake-pdf-content"
        b64_value = base64.b64encode(raw_bytes).decode()
        source = InputContentDataSource(value=b64_value, mime_type="application/pdf")
        content = [DocumentInputContent(source=source)]

        result = convert_agui_content_to_strands(content)

        assert len(result) == 1
        assert "document" in result[0]
        assert result[0]["document"]["format"] == "pdf"
        assert result[0]["document"]["name"] == "document"
        assert result[0]["document"]["source"]["bytes"] == raw_bytes

    def test_video_with_data_source(self):
        raw_bytes = b"fake-video-content"
        b64_value = base64.b64encode(raw_bytes).decode()
        source = InputContentDataSource(value=b64_value, mime_type="video/mp4")
        content = [VideoInputContent(source=source)]

        result = convert_agui_content_to_strands(content)

        assert len(result) == 1
        assert "video" in result[0]
        assert result[0]["video"]["format"] == "mp4"
        assert result[0]["video"]["source"]["bytes"] == raw_bytes

    @patch("ag_ui_strands.utils.logger")
    def test_audio_content_skipped_with_warning(self, mock_logger):
        raw_bytes = b"fake-audio-content"
        b64_value = base64.b64encode(raw_bytes).decode()
        source = InputContentDataSource(value=b64_value, mime_type="audio/mpeg")
        content = [AudioInputContent(source=source)]

        result = convert_agui_content_to_strands(content)

        assert result == []
        mock_logger.warning.assert_called()
        # Verify the warning mentions audio
        warning_msg = mock_logger.warning.call_args[0][0]
        assert "audio" in warning_msg.lower()

    def test_empty_content_returns_empty(self):
        result = convert_agui_content_to_strands([])
        assert result == []

    def test_binary_input_content_with_data(self):
        """Test deprecated BinaryInputContent with base64 data."""
        from ag_ui.core import BinaryInputContent
        from ag_ui_strands.utils import convert_agui_content_to_strands

        import base64
        b64_data = base64.b64encode(b"binary-img").decode()
        content = [
            BinaryInputContent(type="binary", mime_type="image/png", data=b64_data)
        ]
        result = convert_agui_content_to_strands(content)

        assert len(result) == 1
        assert "image" in result[0]
        assert result[0]["image"]["format"] == "png"
        assert result[0]["image"]["source"]["bytes"] == b"binary-img"

    def test_binary_input_content_with_url(self):
        """Test deprecated BinaryInputContent with URL."""
        from ag_ui.core import BinaryInputContent
        from ag_ui_strands.utils import convert_agui_content_to_strands

        content = [
            BinaryInputContent(type="binary", mime_type="image/jpeg", url="https://example.com/img.jpg")
        ]

        with patch("ag_ui_strands.utils._fetch_url_bytes", return_value=b"url-bytes"):
            result = convert_agui_content_to_strands(content)

        assert len(result) == 1
        assert result[0]["image"]["format"] == "jpeg"

    def test_malformed_base64_skipped(self):
        """Test that malformed base64 in data source is skipped gracefully."""
        from ag_ui_strands.utils import convert_agui_content_to_strands

        content = [
            ImageInputContent(
                type="image",
                source=InputContentDataSource(type="data", value="!!!not-base64!!!", mime_type="image/png"),
            )
        ]
        result = convert_agui_content_to_strands(content)
        assert len(result) == 0  # Skipped due to decode failure


# ---------------------------------------------------------------------------
# flatten_content_to_text
# ---------------------------------------------------------------------------


class TestFlattenContentToText:
    """Tests for flatten_content_to_text."""

    def test_string_passthrough(self):
        result = flatten_content_to_text("Hello")
        assert result == "Hello"

    def test_text_only_list(self):
        content = [
            TextInputContent(text="Hello"),
            TextInputContent(text="World"),
        ]
        result = flatten_content_to_text(content)
        assert result == "Hello World"

    def test_mixed_list_extracts_text(self):
        raw_bytes = b"img"
        b64_value = base64.b64encode(raw_bytes).decode()
        source = InputContentDataSource(value=b64_value, mime_type="image/png")
        content = [
            TextInputContent(text="Hello"),
            ImageInputContent(source=source),
            TextInputContent(text="World"),
        ]
        result = flatten_content_to_text(content)
        assert result == "Hello World"

    def test_empty_list(self):
        result = flatten_content_to_text([])
        assert result == ""

    def test_none_returns_empty(self):
        result = flatten_content_to_text(None)
        assert result == ""


# ---------------------------------------------------------------------------
# _mime_to_format
# ---------------------------------------------------------------------------


class TestMimeToFormat:
    """Tests for _mime_to_format."""

    def test_image_png(self):
        result = _mime_to_format("image/png", {"png", "jpeg", "gif", "webp"})
        assert result == "png"

    def test_image_jpeg(self):
        result = _mime_to_format("image/jpeg", {"png", "jpeg", "gif", "webp"})
        assert result == "jpeg"

    def test_application_pdf(self):
        result = _mime_to_format(
            "application/pdf",
            {"pdf", "csv", "doc", "docx", "xls", "xlsx", "html", "txt", "md"},
        )
        assert result == "pdf"

    def test_unknown_mime_fallback(self):
        result = _mime_to_format("application/octet-stream", {"png", "jpeg", "gif", "webp"})
        # Falls back to first sorted allowed format
        assert result == "gif"

    def test_none_mime_fallback(self):
        result = _mime_to_format(None, {"png", "jpeg", "gif", "webp"})
        # Falls back to first sorted allowed format
        assert result == "gif"


# ---------------------------------------------------------------------------
# Agent-level multimodal integration tests
# ---------------------------------------------------------------------------


class MockStrandsAgentForMultimodal:
    """Mock Strands agent that records the prompt passed to stream_async."""

    def __init__(self):
        self.last_prompt = None
        self.model = MagicMock()
        self.system_prompt = "test"
        self.tool_registry = MagicMock()
        self.tool_registry.registry = {}
        self.record_direct_tool_call = True

    async def stream_async(self, prompt):
        self.last_prompt = prompt
        yield {"data": "response"}
        yield {"complete": True}


def _make_input(messages):
    """Create a minimal mock RunAgentInput."""
    input_data = MagicMock()
    input_data.thread_id = "test-thread"
    input_data.run_id = "test-run"
    input_data.state = {}
    input_data.tools = []
    input_data.messages = messages
    return input_data


class TestAgentMultimodalIntegration:
    """Integration tests verifying multimodal content flows through agent.run()."""

    @pytest.mark.asyncio
    async def test_multimodal_user_message_converted(self):
        """When user message has image content, stream_async receives a list."""
        from ag_ui_strands.agent import StrandsAgent

        # Build a mock base agent to satisfy the StrandsAgent constructor
        mock_base = MockStrandsAgentForMultimodal()
        agent = StrandsAgent(mock_base, name="test", description="test")

        # Inject a recording mock agent for the thread
        mock_strands = MockStrandsAgentForMultimodal()
        agent._agents_by_thread["test-thread"] = mock_strands

        # Build a user message with mixed text + image content
        b64_data = base64.b64encode(b"fake-image").decode()
        mock_msg = MagicMock()
        mock_msg.role = "user"
        mock_msg.content = [
            TextInputContent(type="text", text="What is this?"),
            ImageInputContent(
                type="image",
                source=InputContentDataSource(
                    type="data", value=b64_data, mime_type="image/png"
                ),
            ),
        ]

        input_data = _make_input([mock_msg])

        events = []
        async for event in agent.run(input_data):
            events.append(event)

        # The prompt passed to stream_async should be a list (Strands ContentBlock list)
        assert isinstance(mock_strands.last_prompt, list), (
            f"Expected list for multimodal prompt, got {type(mock_strands.last_prompt)}"
        )
        # Should contain a text block and an image block
        assert any("text" in block for block in mock_strands.last_prompt)
        assert any("image" in block for block in mock_strands.last_prompt)

    @pytest.mark.asyncio
    async def test_text_only_list_flattened_to_string(self):
        """When user message content is a list of text-only items, it's flattened to a string."""
        from ag_ui_strands.agent import StrandsAgent

        mock_base = MockStrandsAgentForMultimodal()
        agent = StrandsAgent(mock_base, name="test", description="test")

        mock_strands = MockStrandsAgentForMultimodal()
        agent._agents_by_thread["test-thread"] = mock_strands

        mock_msg = MagicMock()
        mock_msg.role = "user"
        mock_msg.content = [TextInputContent(type="text", text="Hello world")]

        input_data = _make_input([mock_msg])

        events = []
        async for event in agent.run(input_data):
            events.append(event)

        # Should be flattened to a plain string
        assert isinstance(mock_strands.last_prompt, str), (
            f"Expected str for text-only list, got {type(mock_strands.last_prompt)}"
        )
        assert mock_strands.last_prompt == "Hello world"

    @pytest.mark.asyncio
    async def test_plain_string_message_unchanged(self):
        """When content is a plain string, it passes through unchanged."""
        from ag_ui_strands.agent import StrandsAgent

        mock_base = MockStrandsAgentForMultimodal()
        agent = StrandsAgent(mock_base, name="test", description="test")

        mock_strands = MockStrandsAgentForMultimodal()
        agent._agents_by_thread["test-thread"] = mock_strands

        mock_msg = MagicMock()
        mock_msg.role = "user"
        mock_msg.content = "Just a plain string"

        input_data = _make_input([mock_msg])

        events = []
        async for event in agent.run(input_data):
            events.append(event)

        assert isinstance(mock_strands.last_prompt, str)
        assert mock_strands.last_prompt == "Just a plain string"
