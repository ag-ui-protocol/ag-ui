"""Tests for AG-UI to Strands multimodal content conversion utilities."""

from __future__ import annotations

import base64
import logging
import re
from types import SimpleNamespace
from typing import Optional
from unittest.mock import MagicMock, patch

import pytest
from pydantic import BaseModel
from ag_ui.core import (
    EventType,
    AudioInputContent,
    BinaryInputContent,
    DocumentInputContent,
    ImageInputContent,
    InputContentDataSource,
    InputContentUrlSource,
    TextInputContent,
    UserMessage,
    VideoInputContent,
)

from ag_ui_strands.utils import (
    UrlFetchPolicy,
    convert_agui_content_to_strands,
    flatten_content_to_text,
    _mime_to_format,
)
from ag_ui_strands.agent import StrandsAgent, _build_strands_history, _build_snapshot_messages


# ── THE `file` PART SOURCE ───────────────────────────────────────────────────
#
# AG-UI 1.0 gave `PartSource` a third arm: `{"type": "file", "value", provider?,
# mimeType?}` — bytes that ALREADY LIVE AT A MODEL PROVIDER, named by a handle
# that provider issued (an OpenAI/Anthropic file id, a Gemini file URI). No
# bytes travel with one and nothing may fetch it: `value` is opaque and is
# expressly NOT a URL.
#
# `ag_ui.core.FileSource` is the class for it, but this package floors at
# `ag-ui-protocol>=0.1.22` and the published wheel does not export it yet, so
# importing it unconditionally would make this module uncollectable on the very
# SDK CI installs. A local stand-in of the same SHAPE keeps the converter under
# test on both vintages — `_resolve_source_bytes` recognizes a source by class
# and refuses everything else — and the binding flips to the real class as soon
# as the SDK carrying it is released.
try:  # pragma: no cover - depends on the installed SDK
    from ag_ui.core import FileSource  # type: ignore[attr-defined]
except ImportError:  # pragma: no cover - published floor predates PartSource.file
    class FileSource(BaseModel):
        type: str = "file"
        value: str
        provider: Optional[str] = None
        mime_type: Optional[str] = None


def test_file_source_document_is_dropped_without_a_fetch(caplog):
    """A `file` source is SKIPPED with a warning, and nothing is fetched.

    The handle is opaque: `value` is not a URL, so the URL-fetch leg must not
    see it — an adapter that treated a handle as an address would turn a part it
    merely cannot use into an outbound request (and, with a handle that happens
    to parse as a URL, an SSRF surface this adapter's fetch policy exists to
    close). Bedrock has no provider-handle block either, and mapping one is a
    separate decision 1.0 does not make.

    So the document is dropped and the text part survives, which is what the
    spec requires of a producer that cannot use a content part — never a failed
    run.

    Built with `model_construct` because under the published floor this package
    declares, a part's `source` is a DISCRIMINATED union of `data` and `url`
    only: a validated `file` source is refused at the boundary there, before the
    converter runs.
    """
    document = DocumentInputContent.model_construct(
        type="document",
        source=FileSource(
            type="file",
            value="file-abc123",
            provider="openai",
            mime_type="application/pdf",
        ),
        metadata=None,
    )
    dropped: list = []

    # A usable return value on purpose: an adapter that DID treat the handle as
    # a URL would then succeed and emit a document block, so the assertions
    # below fail on `assert_not_called` — the behaviour under test — rather than
    # on a TypeError from a MagicMock reaching Bedrock's byte field.
    with patch("ag_ui_strands.utils._fetch_url_bytes", return_value=b"%PDF-") as fetch:
        with caplog.at_level(logging.WARNING, logger="ag_ui_strands.utils"):
            blocks = convert_agui_content_to_strands(
                [TextInputContent(type="text", text="summarize this"), document],
                message_id="m1",
                dropped=dropped,
            )

    fetch.assert_not_called()
    assert blocks == [{"text": "summarize this"}]
    assert "file-abc123" not in repr(blocks)
    assert dropped == [{"type": "document", "reason": "content could not be resolved"}]

    warnings = [r for r in caplog.records if r.name == "ag_ui_strands.utils"]
    assert len(warnings) == 1


@pytest.mark.parametrize("media_class,mime", [
    (ImageInputContent, "image/png"),
    (DocumentInputContent, "application/pdf"),
    (VideoInputContent, "video/mp4"),
])
@pytest.mark.parametrize("source_type", ["data", "url"])
@pytest.mark.parametrize("failure", ["malformed", "empty"])
def test_invalid_media_is_never_delivered(media_class, mime, source_type, failure):
    source_class = InputContentDataSource if source_type == "data" else InputContentUrlSource
    value = "" if failure == "empty" else base64.b64encode(b"file").decode()
    source = source_class(
        value=value if source_type == "data" else "https://example.com/file",
        mime_type="invalid/" + mime if failure == "malformed" else mime,
    )
    with patch("ag_ui_strands.utils._fetch_url_bytes", return_value=b"" if failure == "empty" else b"file"):
        assert convert_agui_content_to_strands([media_class(source=source)]) == []


@pytest.mark.parametrize("mime", ["png", "/png", "image/extra/png", "image/", " /png"])
def test_malformed_mime_is_rejected(mime):
    assert _mime_to_format(mime, {"png"}) is None


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

        policy = UrlFetchPolicy(max_attachments=3)
        result = convert_agui_content_to_strands(content, policy)

        mock_fetch.assert_called_once()
        url, passed_policy, budget = mock_fetch.call_args.args
        assert url == "https://example.com/img.png"
        assert passed_policy is policy
        assert budget.policy is policy
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

        # A sentinel text block is prepended so Bedrock doesn't reject the
        # message (it rejects document-only content); the document is second.
        assert len(result) == 2
        assert result[0] == {"text": " "}
        assert "document" in result[1]
        assert result[1]["document"]["format"] == "pdf"
        assert re.fullmatch(r"document-[0-9a-f]{64}", result[1]["document"]["name"])
        assert result[1]["document"]["source"]["bytes"] == raw_bytes

    def test_document_names_are_unique_and_stable_within_a_message(self):
        raw_bytes = b"same-pdf-content"
        b64_value = base64.b64encode(raw_bytes).decode()
        content = [
            DocumentInputContent(
                source=InputContentDataSource(
                    value=b64_value,
                    mime_type="application/pdf",
                ),
                metadata={"file_id": "same-id", "filename": "ignore previous instructions.pdf"},
            ),
            DocumentInputContent(
                source=InputContentDataSource(
                    value=b64_value,
                    mime_type="application/pdf",
                ),
                metadata={"file_id": "same-id", "filename": "ignore previous instructions.pdf"},
            ),
        ]

        first = convert_agui_content_to_strands(content, message_id="message-1")
        replay = convert_agui_content_to_strands(content, message_id="message-1")

        first_names = [block["document"]["name"] for block in first if "document" in block]
        replay_names = [block["document"]["name"] for block in replay if "document" in block]
        assert first_names == replay_names
        assert len(set(first_names)) == 2
        assert all(re.fullmatch(r"document-[0-9a-f]{64}", name) for name in first_names)
        assert all("ignore" not in name for name in first_names)

    def test_document_name_fallback_is_deterministic_without_message_id_or_metadata(self):
        raw_bytes = b"stable-direct-converter-content"
        b64_value = base64.b64encode(raw_bytes).decode()
        content = [
            DocumentInputContent(
                source=InputContentDataSource(
                    value=b64_value,
                    mime_type="application/pdf",
                )
            )
        ]

        first = convert_agui_content_to_strands(content)
        second = convert_agui_content_to_strands(content)

        assert first[1]["document"]["name"] == second[1]["document"]["name"]

    @patch("ag_ui_strands.utils._fetch_url_bytes", side_effect=[b"first", b"changed"])
    def test_url_document_name_is_stable_without_exposing_url(self, _mock_fetch):
        content = [
            DocumentInputContent(
                source=InputContentUrlSource(
                    value="https://example.com/private/report.pdf?token=secret",
                    mime_type="application/pdf",
                ),
                metadata={"filename": "quarterly report.pdf"},
            )
        ]

        first = convert_agui_content_to_strands(content, message_id="message-url")
        second = convert_agui_content_to_strands(content, message_id="message-url")

        name = first[1]["document"]["name"]
        assert name == second[1]["document"]["name"]
        assert "report" not in name
        assert "secret" not in name

    def test_document_only_gets_text_prefix(self):
        """Bedrock rejects a message with only document blocks; a sentinel text
        block must be prepended so the request is valid."""
        raw_bytes = b"fake-pdf-content"
        b64_value = base64.b64encode(raw_bytes).decode()
        source = InputContentDataSource(value=b64_value, mime_type="application/pdf")
        content = [DocumentInputContent(source=source)]

        result = convert_agui_content_to_strands(content)

        assert result[0] == {"text": " "}, "sentinel text block must be first"
        assert len(result) == 2
        assert "document" in result[1]

    def test_document_with_text_no_extra_prefix(self):
        """When the caller already includes a text block alongside a document,
        no sentinel block should be inserted."""
        raw_bytes = b"fake-pdf-content"
        b64_value = base64.b64encode(raw_bytes).decode()
        source = InputContentDataSource(value=b64_value, mime_type="application/pdf")
        content = [
            TextInputContent(text="Here is the file:"),
            DocumentInputContent(source=source),
        ]

        result = convert_agui_content_to_strands(content)

        assert result[0] == {"text": "Here is the file:"}
        assert len(result) == 2
        assert "document" in result[1]

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

        content = [
            BinaryInputContent(type="binary", mime_type="image/jpeg", url="https://example.com/img.jpg")
        ]

        with patch("ag_ui_strands.utils._fetch_url_bytes", return_value=b"url-bytes"):
            result = convert_agui_content_to_strands(content)

        assert len(result) == 1
        assert result[0]["image"]["format"] == "jpeg"

    def test_malformed_base64_skipped(self):
        """Test that malformed base64 in data source is skipped gracefully."""

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

    def test_unknown_mime_returns_none(self):
        result = _mime_to_format("application/octet-stream", {"png", "jpeg", "gif", "webp"})
        assert result is None

    def test_none_mime_returns_none(self):
        result = _mime_to_format(None, {"png", "jpeg", "gif", "webp"})
        assert result is None

    def test_unsupported_mime_skips_image_block(self):
        """An image with an unsupported MIME type should be skipped entirely."""
        raw_bytes = b"fake-tiff-data"
        b64_value = base64.b64encode(raw_bytes).decode()
        source = InputContentDataSource(value=b64_value, mime_type="image/tiff")
        content = [ImageInputContent(source=source)]

        result = convert_agui_content_to_strands(content)
        assert result == []

    def test_missing_mime_skips_image_block(self):
        """An image with no MIME type should be skipped entirely.

        ``InputContentDataSource`` now requires ``mime_type``, so we use
        ``model_construct`` to bypass validation and simulate a source
        object that somehow lacks the attribute.
        """
        raw_bytes = b"fake-image-data"
        b64_value = base64.b64encode(raw_bytes).decode()
        source = InputContentDataSource.model_construct(value=b64_value)
        content = [ImageInputContent(source=source)]

        result = convert_agui_content_to_strands(content)
        assert result == []


# ---------------------------------------------------------------------------
# Agent-level multimodal integration tests
# ---------------------------------------------------------------------------


class MockStrandsAgentForMultimodal:
    """Mock Strands agent that records how, and whether, it was invoked.

    ``last_prompt`` alone cannot answer whether the agent ran: the adapter
    passes ``None`` as the prompt whenever it has already reconciled the turn
    into ``messages``, which is the usual case. ``stream_calls`` is what a test
    about a run that must not reach the agent asserts on.
    """

    def __init__(self):
        self.last_prompt = None
        self.stream_calls = 0
        self.model = MagicMock()
        self.system_prompt = "test"
        self.tool_registry = MagicMock()
        self.tool_registry.registry = {}
        self.record_direct_tool_call = True
        # The adapter reconciles ``self.messages`` with ``RunAgentInput.messages``
        # before invoking ``stream_async`` (when no ``session_manager`` is wired),
        # so the user content under test now lands here rather than in the
        # ``stream_async(prompt)`` argument.
        self.messages: list = []
        self.session_manager = None

    async def stream_async(self, prompt):
        self.stream_calls += 1
        self.last_prompt = prompt
        yield {"data": "response"}
        yield {"complete": True}


def _make_input(messages):
    """Stand-in for ``RunAgentInput`` stating every field it carries.

    A ``MagicMock`` answers ``resume``, ``context`` and ``forwarded_props``
    with truthy mocks nobody stated, which leaves a plain first turn one
    defensive check away from being read as a resume. ``SimpleNamespace``
    states the empty first-turn values, and makes a field the adapter starts
    reading fail out loud rather than be answered with a mock.
    """
    return SimpleNamespace(
        thread_id="test-thread",
        run_id="test-run",
        state={},
        tools=[],
        messages=messages,
        context=[],
        forwarded_props={},
        resume=None,
    )


class TestAgentMultimodalIntegration:
    """Integration tests verifying multimodal content flows through agent.run()."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize("with_text", [True, False])
    @pytest.mark.parametrize("mime,payload,reason", [
        ("invalid/image/png", "ZmlsZQ==", "unsupported media type"),
        ("image/bmp", "ZmlsZQ==", "unsupported media type"),
        ("image/png", "", "content was empty"),
        ("image/png", "a", "content could not be resolved"),
    ])
    async def test_media_drop_is_visible_before_terminal_event(self, with_text, mime, payload, reason):
        core = MockStrandsAgentForMultimodal()
        agent = StrandsAgent(MockStrandsAgentForMultimodal(), name="test", description="test")
        agent._agents_by_thread["test-thread"] = core
        content = [TextInputContent(text="hello")] if with_text else []
        content.append(ImageInputContent(source=InputContentDataSource(value=payload, mime_type=mime)))
        message = UserMessage(id="upload", content=content)

        events = [event async for event in agent.run(_make_input([message]))]

        drops = [event for event in events if event.type == EventType.CUSTOM and event.name == "MediaDropped"]
        assert len(drops) == 1
        assert drops[0].value == {"dropped": [{"type": "image", "reason": reason}], "delivered": 0}
        assert events.index(drops[0]) < len(events) - 1
        assert core.stream_calls == int(with_text)
        assert events[-1].type == (EventType.RUN_FINISHED if with_text else EventType.RUN_ERROR)
        if not with_text:
            assert events[-1].code == "MEDIA_RESOLUTION_FAILED"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("payload,reason", [
        (None, "content could not be resolved"),
        (b"", "content was empty"),
    ])
    async def test_url_drop_reports_reason_and_delivered_attachment_count(self, payload, reason):
        core = MockStrandsAgentForMultimodal()
        agent = StrandsAgent(MockStrandsAgentForMultimodal(), name="test", description="test")
        agent._agents_by_thread["test-thread"] = core
        message = UserMessage(id="upload", content=[
            TextInputContent(text="Describe my files"),
            ImageInputContent(source=InputContentDataSource(value="ZmlsZQ==", mime_type="image/png")),
            DocumentInputContent(source=InputContentUrlSource(value="https://example.com/private.pdf?token=secret", mime_type="application/pdf")),
        ])
        with patch("ag_ui_strands.utils._fetch_url_bytes", return_value=payload):
            events = [event async for event in agent.run(_make_input([message]))]
        drops = [event for event in events if event.type == EventType.CUSTOM and event.name == "MediaDropped"]
        assert len(drops) == 1
        assert drops[0].value == {"dropped": [{"type": "document", "reason": reason}], "delivered": 1}
        assert events[-1].type == EventType.RUN_FINISHED
        assert core.stream_calls == 1
        assert all("document" not in block for block in core.messages[-1]["content"])

    def test_replayed_history_keeps_document_names_stable_across_turns(self):

        raw_bytes = b"identical-document-bytes"
        b64_value = base64.b64encode(raw_bytes).decode()

        def message(message_id: str) -> UserMessage:
            return UserMessage(
                id=message_id,
                content=[
                    DocumentInputContent(
                        source=InputContentDataSource(
                            value=b64_value,
                            mime_type="application/pdf",
                        ),
                        metadata={"filename": "same.pdf"},
                    )
                ],
            )

        messages = [message("turn-1"), message("turn-8")]
        first = _build_strands_history(messages)
        replay = _build_strands_history(messages)

        first_names = [
            block["document"]["name"]
            for native_message in first
            for block in native_message["content"]
            if "document" in block
        ]
        replay_names = [
            block["document"]["name"]
            for native_message in replay
            for block in native_message["content"]
            if "document" in block
        ]

        assert first_names == replay_names
        assert len(first_names) == 2
        assert len(set(first_names)) == 2

    @pytest.mark.asyncio
    async def test_session_manager_prompt_uses_message_scoped_document_name(self):

        mock_base = MockStrandsAgentForMultimodal()
        agent = StrandsAgent(mock_base, name="test", description="test")

        mock_strands = MockStrandsAgentForMultimodal()
        mock_strands.session_manager = object()
        agent._agents_by_thread["test-thread"] = mock_strands

        raw_bytes = b"session-managed-document"
        message = UserMessage(
            id="session-message-1",
            content=[
                DocumentInputContent(
                    source=InputContentDataSource(
                        value=base64.b64encode(raw_bytes).decode(),
                        mime_type="application/pdf",
                    )
                )
            ],
        )

        events = []
        async for event in agent.run(_make_input([message])):
            events.append(event)

        expected = convert_agui_content_to_strands(
            message.content,
            message_id=message.id,
        )
        assert mock_strands.last_prompt == expected
        assert mock_strands.last_prompt[1]["document"]["name"] != "document"

    @pytest.mark.asyncio
    async def test_multimodal_user_message_converted(self):
        """When user message has image content, stream_async receives a list."""

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

        # The reconciled history now carries the multimodal content as the
        # last user turn's ``content`` (Strands ContentBlock list).
        assert mock_strands.messages, "expected reconciled history on Strands agent"
        last_user = mock_strands.messages[-1]
        assert last_user["role"] == "user"
        assert isinstance(last_user["content"], list)
        assert any("text" in block for block in last_user["content"])
        assert any("image" in block for block in last_user["content"])

    @pytest.mark.asyncio
    async def test_unconvertible_media_with_no_text_fails_the_run(self):
        """A prompt stripped of everything the user sent is not worth sending."""

        agent = StrandsAgent(
            MockStrandsAgentForMultimodal(), name="test", description="test"
        )
        mock_strands = MockStrandsAgentForMultimodal()
        mock_strands.session_manager = object()
        agent._agents_by_thread["test-thread"] = mock_strands

        message = UserMessage(
            id="unconvertible-1",
            content=[
                ImageInputContent(
                    source=InputContentDataSource(
                        value=base64.b64encode(b"fake-tiff").decode(),
                        mime_type="image/tiff",
                    )
                )
            ],
        )

        events = [event async for event in agent.run(_make_input([message]))]

        assert mock_strands.stream_calls == 0, "the agent was invoked anyway"
        assert events[-1].type == EventType.RUN_ERROR
        assert events[-1].code == "MEDIA_RESOLUTION_FAILED"

    @pytest.mark.asyncio
    async def test_unconvertible_media_falls_back_to_the_text_the_user_sent(self):
        """Every block is dropped by the converter, but the typed text survives.

        The text arrives as a raw ``{"type": "text", ...}`` mapping rather than
        a validated ``TextInputContent``, which is the shape that reaches this
        path when history is replayed without model validation. The converter
        yields nothing for a mapping, so the whole prompt is empty and the
        fallback has to recover the text instead of failing the run.
        """

        agent = StrandsAgent(
            MockStrandsAgentForMultimodal(), name="test", description="test"
        )
        mock_strands = MockStrandsAgentForMultimodal()
        mock_strands.session_manager = object()
        agent._agents_by_thread["test-thread"] = mock_strands

        message = UserMessage.model_construct(
            id="unconvertible-2",
            role="user",
            content=[
                {"type": "text", "text": "what is in this picture?"},
                ImageInputContent(
                    source=InputContentDataSource(
                        value=base64.b64encode(b"fake-tiff").decode(),
                        mime_type="image/tiff",
                    )
                ),
            ],
        )

        # Without this the run never enters the fallback at all: a converter
        # that returns the text itself leaves nothing for the fallback to do.
        assert convert_agui_content_to_strands(message.content) == []
        assert flatten_content_to_text(message.content) == "what is in this picture?"

        events = [event async for event in agent.run(_make_input([message]))]

        assert all(event.type != EventType.RUN_ERROR for event in events)
        assert mock_strands.stream_calls == 1, "the surviving text never reached the agent"
        assert mock_strands.last_prompt == "what is in this picture?"

    @pytest.mark.asyncio
    async def test_text_only_list_flattened_to_string(self):
        """When user message content is a list of text-only items, it's flattened to a string."""

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

        # Text-only list should land in reconciled history as a single
        # text ContentBlock under the last user turn.
        assert mock_strands.messages, "expected reconciled history on Strands agent"
        last_user = mock_strands.messages[-1]
        assert last_user["role"] == "user"
        assert last_user["content"] == [{"text": "Hello world"}]

    @pytest.mark.asyncio
    async def test_plain_string_message_unchanged(self):
        """When content is a plain string, it passes through unchanged."""

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

        assert mock_strands.messages, "expected reconciled history on Strands agent"
        last_user = mock_strands.messages[-1]
        assert last_user["role"] == "user"
        assert last_user["content"] == [{"text": "Just a plain string"}]


# ---------------------------------------------------------------------------
# _build_snapshot_messages unit tests
# ---------------------------------------------------------------------------


class TestBuildSnapshotMessages:
    """Unit tests for _build_snapshot_messages in agent.py.

    Focuses on the multimodal content preservation path: list content must
    pass through as-is instead of being coerced to a string.
    """

    def _make_msg(self, role, content):
        msg = MagicMock()
        msg.role = role
        msg.content = content
        msg.id = "msg-1"
        msg.tool_calls = None
        msg.tool_call_id = None
        return msg

    def test_string_content_preserved(self):

        msg = self._make_msg("user", "hello")
        result = _build_snapshot_messages([msg])

        assert len(result) == 1
        assert result[0].content == "hello"

    def test_list_content_preserved_as_list(self):
        """List content (multimodal) must not be stringified — it should reach
        the MessagesSnapshotEvent intact so the frontend can render images."""

        list_content = [
            TextInputContent(type="text", text="look at this"),
            ImageInputContent(
                type="image",
                source=InputContentDataSource(
                    type="data",
                    value=base64.b64encode(b"img").decode(),
                    mime_type="image/png",
                ),
            ),
        ]
        msg = self._make_msg("user", list_content)
        result = _build_snapshot_messages([msg])

        assert len(result) == 1
        assert isinstance(result[0].content, list), (
            "_build_snapshot_messages coerced list content to string"
        )
        assert result[0].content == list_content

    def test_unexpected_type_coerced_to_string(self):
        """Non-str/non-list content (e.g. an int) falls back to _coerce_text."""

        msg = self._make_msg("user", 42)
        result = _build_snapshot_messages([msg])

        assert len(result) == 1
        assert isinstance(result[0].content, str)
