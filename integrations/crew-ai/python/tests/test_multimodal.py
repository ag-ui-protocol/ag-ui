"""Tests for multimodal input passthrough in the CrewAI bridge.

Covers the forward converter (AG-UI parts to LiteLLM image_url blocks),
dump_agui_message, crewai_prepare_inputs, the reverse converter used by the
MESSAGES_SNAPSHOT path, and the crewai-files capability-probe warning both with
and without the optional distribution installed.
"""

import dataclasses
import logging
from typing import Optional

import pytest
from pydantic import BaseModel

from ag_ui.core import (
    UserMessage,
    AssistantMessage,
    TextInputContent,
    BinaryInputContent,
    ImageInputContent,
    AudioInputContent,
    VideoInputContent,
    DocumentInputContent,
    InputContentDataSource,
    InputContentUrlSource,
)

from ag_ui.core import ImageInputContent as _ImageInputContent
from ag_ui.core import TextInputContent as _TextInputContent

from ag_ui_crewai import _capabilities
from ag_ui_crewai.utils import (
    convert_agui_multimodal_to_litellm,
    convert_litellm_multimodal_to_agui,
    dump_agui_message,
)
from ag_ui_crewai.sdk import litellm_messages_to_ag_ui_messages
from ag_ui_crewai.endpoint import crewai_prepare_inputs


# ── THE `file` PART SOURCE ───────────────────────────────────────────────────
#
# AG-UI 1.0 gave `PartSource` a third arm: `{"type": "file", "value", provider?,
# mimeType?}` — bytes that ALREADY LIVE AT A MODEL PROVIDER, named by a handle
# that provider issued (an OpenAI/Anthropic file id, a Gemini file URI). No
# bytes travel with one and nothing may fetch it: `value` is opaque and is
# expressly NOT a URL.
#
# `ag_ui.core.FileSource` is the class for it, but this package floors at
# `ag-ui-protocol>=0.1.19` and the published wheels do not export it yet, so
# importing it unconditionally would make this module uncollectable on the very
# SDK CI installs. A local stand-in of the same SHAPE keeps the adapter under
# test on both vintages — the adapter matches the source by its `type`
# discriminator, not by class — and the import flips to the real class as soon
# as the SDK carrying it is released.
try:  # pragma: no cover - depends on the installed SDK
    from ag_ui.core import FileSource  # type: ignore[attr-defined]
except ImportError:  # pragma: no cover - published floor predates PartSource.file
    class FileSource(BaseModel):
        type: str = "file"
        value: str
        provider: Optional[str] = None
        mime_type: Optional[str] = None


def _file_sourced_document_message():
    """A user message: one text part, one `file`-sourced PDF document.

    Built with `model_construct` rather than validated: under the published
    floor above, a part's `source` is a DISCRIMINATED union of `data` and `url`
    only, so a `file` source is refused at the boundary before any adapter code
    runs. The adapter's own behaviour is what these tests pin.
    """
    return UserMessage.model_construct(
        id="u-file",
        role="user",
        content=[
            TextInputContent(type="text", text="summarize this"),
            DocumentInputContent.model_construct(
                type="document",
                source=FileSource(
                    type="file",
                    value="file-abc123",
                    provider="openai",
                    mime_type="application/pdf",
                ),
                metadata=None,
            ),
        ],
    )


@pytest.fixture(autouse=True)
def _reset_multimodal_warning():
    """Reset the one-shot multimodal-gap warning flag around each test.

    The flag is process-global; without a reset a prior test's warning would
    suppress a later assertion (mirrors the ``_ALIAS_WARN_SEEN`` reset in
    ``conftest``).
    """
    _capabilities._multimodal_files_gap_warned = False
    yield
    _capabilities._multimodal_files_gap_warned = False


# ── convert_agui_multimodal_to_litellm ──────────────────────────────────────

def test_text_only_part_to_litellm():
    content = [TextInputContent(type="text", text="Hello, world!")]
    result = convert_agui_multimodal_to_litellm(content)
    assert result == [{"type": "text", "text": "Hello, world!"}]


def test_image_url_source_to_litellm():
    content = [
        TextInputContent(type="text", text="Describe this image"),
        ImageInputContent(
            type="image",
            source=InputContentUrlSource(type="url", value="https://example.com/photo.jpg"),
        ),
    ]
    result = convert_agui_multimodal_to_litellm(content)
    assert result == [
        {"type": "text", "text": "Describe this image"},
        {"type": "image_url", "image_url": {"url": "https://example.com/photo.jpg"}},
    ]


def test_image_data_source_to_litellm():
    content = [
        ImageInputContent(
            type="image",
            source=InputContentDataSource(
                type="data", value="iVBORw0KGgoAAAANSUhEUgAAAAUA", mime_type="image/png"
            ),
        ),
    ]
    result = convert_agui_multimodal_to_litellm(content)
    assert result == [
        {
            "type": "image_url",
            "image_url": {"url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA"},
        }
    ]


@pytest.mark.parametrize(
    "cls, ctype, mime, data, expected_prefix",
    [
        (AudioInputContent, "audio", "audio/mp3", "SGVsbG8=", "data:audio/mp3;base64,"),
        (VideoInputContent, "video", "video/mp4", "AAAA", "data:video/mp4;base64,"),
        (DocumentInputContent, "document", "application/pdf", "JVBERi0=", "data:application/pdf;base64,"),
    ],
)
def test_media_types_data_source_route_through_image_url(cls, ctype, mime, data, expected_prefix):
    """Documents a KNOWN LIMITATION: audio/video/document are routed through
    image_url (LangGraph parity). Providers with native input_audio/video_url/
    file blocks may reject these; images are the supported path."""
    content = [cls(type=ctype, source=InputContentDataSource(type="data", value=data, mime_type=mime))]
    result = convert_agui_multimodal_to_litellm(content)
    assert len(result) == 1
    assert result[0]["type"] == "image_url"
    assert result[0]["image_url"]["url"] == expected_prefix + data


@pytest.mark.parametrize(
    "cls, ctype",
    [
        (AudioInputContent, "audio"),
        (VideoInputContent, "video"),
        (DocumentInputContent, "document"),
    ],
)
def test_media_types_url_source_route_through_image_url(cls, ctype):
    """Known limitation (see the data-source variant): non-image media rides
    image_url for LangGraph parity and may be provider-rejected."""
    content = [cls(type=ctype, source=InputContentUrlSource(type="url", value="https://example.com/x"))]
    result = convert_agui_multimodal_to_litellm(content)
    assert result == [{"type": "image_url", "image_url": {"url": "https://example.com/x"}}]


def test_metadata_not_leaked_to_blocks():
    """Metadata must not reach the model payload; strict providers 400 on it."""
    content = [
        TextInputContent(type="text", text="Describe this image", metadata={"source": "prompt"}),
        ImageInputContent(
            type="image",
            source=InputContentUrlSource(type="url", value="https://example.com/photo.jpg"),
            metadata={"provider_hint": "vision"},
        ),
    ]
    result = convert_agui_multimodal_to_litellm(content)
    for block in result:
        assert "metadata" not in block
    assert result == [
        {"type": "text", "text": "Describe this image"},
        {"type": "image_url", "image_url": {"url": "https://example.com/photo.jpg"}},
    ]


# ── BinaryInputContent (legacy) ──────────────────────────────────────────────

def test_binary_url_to_litellm():
    content = [
        TextInputContent(type="text", text="What's in this image?"),
        BinaryInputContent(type="binary", mime_type="image/jpeg", url="https://example.com/photo.jpg"),
    ]
    result = convert_agui_multimodal_to_litellm(content)
    assert result == [
        {"type": "text", "text": "What's in this image?"},
        {"type": "image_url", "image_url": {"url": "https://example.com/photo.jpg"}},
    ]


def test_binary_data_to_litellm():
    content = [
        BinaryInputContent(type="binary", mime_type="image/png", data="iVBORw0KGgo", filename="test.png"),
    ]
    result = convert_agui_multimodal_to_litellm(content)
    assert result[0]["type"] == "image_url"
    assert result[0]["image_url"]["url"] == "data:image/png;base64,iVBORw0KGgo"


def test_binary_id_to_litellm():
    content = [BinaryInputContent(type="binary", mime_type="image/png", id="file-abc123")]
    result = convert_agui_multimodal_to_litellm(content)
    assert result == [{"type": "image_url", "image_url": {"url": "file-abc123"}}]


def test_malformed_binary_dropped():
    """A BinaryInputContent with no url/data/id is dropped, text preserved."""
    malformed = BinaryInputContent.model_construct(
        type="binary", mime_type="image/png", url=None, data=None, id=None
    )
    content = [TextInputContent(type="text", text="Keep me"), malformed]
    result = convert_agui_multimodal_to_litellm(content)
    assert result == [{"type": "text", "text": "Keep me"}]


def test_media_with_unconvertible_source_dropped():
    """A media item whose source yields no URL is dropped (text kept)."""
    item = ImageInputContent.model_construct(type="image", source=object())
    content = [TextInputContent(type="text", text="Keep me"), item]
    result = convert_agui_multimodal_to_litellm(content)
    assert result == [{"type": "text", "text": "Keep me"}]


# ── dump_agui_message ────────────────────────────────────────────────────────

def test_dump_text_user_message_passthrough():
    msg = UserMessage(id="u1", role="user", content="just text")
    dumped = dump_agui_message(msg)
    assert dumped["content"] == "just text"
    assert dumped["role"] == "user"
    assert dumped["id"] == "u1"


def test_dump_assistant_message_passthrough():
    msg = AssistantMessage(id="a1", role="assistant", content="hi there")
    dumped = dump_agui_message(msg)
    assert dumped["content"] == "hi there"


def test_dump_multimodal_user_message_normalized():
    msg = UserMessage(
        id="u2",
        role="user",
        content=[
            TextInputContent(type="text", text="see this"),
            ImageInputContent(
                type="image",
                source=InputContentUrlSource(type="url", value="https://example.com/i.jpg"),
            ),
        ],
    )
    dumped = dump_agui_message(msg)
    assert dumped["id"] == "u2"
    assert dumped["role"] == "user"
    assert dumped["content"] == [
        {"type": "text", "text": "see this"},
        {"type": "image_url", "image_url": {"url": "https://example.com/i.jpg"}},
    ]


# ── crewai_prepare_inputs end-to-end ─────────────────────────────────────────

def _image_user_message():
    return UserMessage(
        id="u3",
        role="user",
        content=[
            TextInputContent(type="text", text="what is this"),
            ImageInputContent(
                type="image",
                source=InputContentDataSource(type="data", value="AAAA", mime_type="image/png"),
            ),
        ],
    )


def _document_user_message():
    return UserMessage(
        id="d1",
        role="user",
        content=[
            TextInputContent(type="text", text="summarize"),
            DocumentInputContent(
                type="document",
                source=InputContentDataSource(type="data", value="JVBERi0=", mime_type="application/pdf"),
            ),
        ],
    )


def test_prepare_inputs_normalizes_multimodal():
    state = crewai_prepare_inputs(state={}, messages=[_image_user_message()], tools=[])
    assert state["messages"][0]["content"] == [
        {"type": "text", "text": "what is this"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
    ]


def test_prepare_inputs_strips_leading_system_message():
    from ag_ui.core import SystemMessage

    messages = [
        SystemMessage(id="s1", role="system", content="you are helpful"),
        _image_user_message(),
    ]
    state = crewai_prepare_inputs(state={}, messages=messages, tools=[])
    assert len(state["messages"]) == 1
    assert state["messages"][0]["id"] == "u3"


# ── media parts through crewai_prepare_inputs (audio/video/document) ─────────

@pytest.mark.parametrize(
    "cls, ctype, mime, value",
    [
        (AudioInputContent, "audio", "audio/mp3", "SGVsbG8="),
        (VideoInputContent, "video", "video/mp4", "AAAA"),
        (DocumentInputContent, "document", "application/pdf", "JVBERi0="),
    ],
)
def test_prepare_inputs_media_types_end_to_end(cls, ctype, mime, value):
    msg = UserMessage(
        id="m1",
        role="user",
        content=[cls(type=ctype, source=InputContentDataSource(type="data", value=value, mime_type=mime))],
    )
    state = crewai_prepare_inputs(state={}, messages=[msg], tools=[])
    assert state["messages"][0]["content"] == [
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{value}"}}
    ]


def test_file_sourced_document_is_dropped_with_a_warning(caplog):
    """A `file` source is SKIPPED with a warning; the text part survives.

    This adapter has no mapping for a provider file handle in 1.0 — LiteLLM's
    `file` block wants a provider-side id this bridge has no way to validate or
    route — and the spec is explicit that a producer which cannot use a content
    part MUST NOT fail the run over it: it skips the part and SHOULD warn.

    The handle is opaque, so what it must NOT become is an `image_url` block:
    `_media_source_to_url` returns None for it, and a None reaching
    `{"image_url": {"url": ...}}` would send the provider an attachment with no
    address in it.
    """
    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai.utils"):
        state = crewai_prepare_inputs(
            state={}, messages=[_file_sourced_document_message()], tools=[]
        )

    content = state["messages"][0]["content"]
    assert content == [{"type": "text", "text": "summarize this"}]
    # Nothing anywhere in the request carries the handle.
    assert "file-abc123" not in repr(state)

    warnings = [r for r in caplog.records if r.name == "ag_ui_crewai.utils"]
    assert len(warnings) == 1
    text = warnings[0].getMessage()
    assert "document" in text
    assert "provider file handle" in text


def test_convert_drop_warnings_fire(caplog):
    """The two drop branches emit a warning on the utils logger."""
    malformed_binary = BinaryInputContent.model_construct(
        type="binary", mime_type="image/png", url=None, data=None, id=None
    )
    bad_media = ImageInputContent.model_construct(type="image", source=object())
    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai.utils"):
        result = convert_agui_multimodal_to_litellm([malformed_binary, bad_media])
    assert result == []
    utils_warnings = [r for r in caplog.records if r.name == "ag_ui_crewai.utils"]
    assert len(utils_warnings) == 2


# ── reverse conversion: LiteLLM blocks back to AG-UI ─────────────────────────

def test_convert_litellm_text_to_agui():
    result = convert_litellm_multimodal_to_agui([{"type": "text", "text": "hi"}])
    assert result == [{"type": "text", "text": "hi"}]


def test_convert_litellm_image_url_to_agui():
    result = convert_litellm_multimodal_to_agui(
        [{"type": "image_url", "image_url": {"url": "https://example.com/i.jpg"}}]
    )
    assert result == [{"type": "image", "source": {"type": "url", "value": "https://example.com/i.jpg"}}]


def test_convert_litellm_data_url_to_agui():
    result = convert_litellm_multimodal_to_agui(
        [{"type": "image_url", "image_url": {"url": "data:image/png;base64,abc123"}}]
    )
    assert result == [
        {"type": "image", "source": {"type": "data", "value": "abc123", "mime_type": "image/png"}}
    ]


def test_convert_litellm_non_dict_skipped():
    result = convert_litellm_multimodal_to_agui(["not-a-dict", {"type": "text", "text": "keep"}])
    assert result == [{"type": "text", "text": "keep"}]


def test_convert_litellm_null_url_dropped_not_crashing(caplog):
    """A null/empty/comma-less image_url is dropped (with a log), never emitted
    as an invalid part that would crash the whole MESSAGES_SNAPSHOT."""
    content = [
        {"type": "text", "text": "keep"},
        {"type": "image_url", "image_url": {"url": None}},
        {"type": "image_url", "image_url": {"url": ""}},
        {"type": "image_url", "image_url": {}},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64"}},  # no comma
        {"type": "somethingelse", "data": 1},
    ]
    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai.utils"):
        result = convert_litellm_multimodal_to_agui(content)
    assert result == [{"type": "text", "text": "keep"}]
    utils_warnings = [r for r in caplog.records if r.name == "ag_ui_crewai.utils"]
    assert len(utils_warnings) == 5


def test_reverse_path_survives_invalid_image_url():
    """A stored message with a null image_url url must not raise or drop the
    snapshot: the bad part is dropped, the valid parts survive."""
    stored = {
        "id": "u1",
        "role": "user",
        "content": [
            {"type": "text", "text": "hello"},
            {"type": "image_url", "image_url": {"url": None}},
        ],
    }
    out = litellm_messages_to_ag_ui_messages([stored])
    assert len(out) == 1
    assert isinstance(out[0].content, list)
    assert len(out[0].content) == 1
    assert isinstance(out[0].content[0], _TextInputContent)


def test_reverse_path_accepts_litellm_multimodal_message():
    """A stored LiteLLM image_url message must round-trip back through
    litellm_messages_to_ag_ui_messages without a ValidationError (which would
    silently drop MESSAGES_SNAPSHOT)."""
    stored = {
        "id": "u1",
        "role": "user",
        "content": [
            {"type": "text", "text": "what is this"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
        ],
    }
    out = litellm_messages_to_ag_ui_messages([stored])
    assert len(out) == 1
    msg = out[0]
    assert isinstance(msg.content, list)
    assert isinstance(msg.content[0], _TextInputContent)
    assert isinstance(msg.content[1], _ImageInputContent)
    assert msg.content[1].source.value == "AAAA"
    assert msg.content[1].source.mime_type == "image/png"


def test_full_round_trip_prepare_then_snapshot():
    """crewai_prepare_inputs output (LiteLLM shape) survives the snapshot
    reverse path back to valid AG-UI messages."""
    state = crewai_prepare_inputs(state={}, messages=[_image_user_message()], tools=[])
    out = litellm_messages_to_ag_ui_messages(state["messages"])
    assert len(out) == 1
    assert isinstance(out[0].content, list)
    assert isinstance(out[0].content[1], _ImageInputContent)


# ── crewai-files capability probe warning ────────────────────────────────────

def test_warn_when_non_image_media_without_crewai_files(caplog, monkeypatch):
    """WITHOUT crewai-files: non-image media triggers exactly one warning."""
    monkeypatch.setattr(
        _capabilities, "CAPABILITIES",
        dataclasses.replace(_capabilities.CAPABILITIES, crewai_files_available=False),
    )
    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._capabilities"):
        dump_agui_message(_document_user_message())
        dump_agui_message(_document_user_message())  # second call must NOT re-warn

    gap_warnings = [r for r in caplog.records if "crewai-files" in r.getMessage()]
    assert len(gap_warnings) == 1
    assert "crewai[file-processing]" in gap_warnings[0].getMessage()


def test_no_warn_for_image_only(caplog, monkeypatch):
    """Images ride image_url and work on any vision provider, so they never
    trigger the gap warning even without crewai-files."""
    monkeypatch.setattr(
        _capabilities, "CAPABILITIES",
        dataclasses.replace(_capabilities.CAPABILITIES, crewai_files_available=False),
    )
    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._capabilities"):
        dump_agui_message(_image_user_message())

    assert not [r for r in caplog.records if "crewai-files" in r.getMessage()]


def test_no_warn_when_crewai_files_available(caplog, monkeypatch):
    """WITH crewai-files installed: no gap warning even for non-image media."""
    monkeypatch.setattr(
        _capabilities, "CAPABILITIES",
        dataclasses.replace(_capabilities.CAPABILITIES, crewai_files_available=True),
    )
    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._capabilities"):
        dump_agui_message(_document_user_message())

    assert not [r for r in caplog.records if "crewai-files" in r.getMessage()]


def test_no_warn_for_text_only(caplog, monkeypatch):
    """Text-only content never triggers the multimodal gap warning."""
    monkeypatch.setattr(
        _capabilities, "CAPABILITIES",
        dataclasses.replace(_capabilities.CAPABILITIES, crewai_files_available=False),
    )
    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._capabilities"):
        dump_agui_message(UserMessage(id="u4", role="user", content="plain text"))

    assert not [r for r in caplog.records if "crewai-files" in r.getMessage()]


# ── reverse converter idempotency + label recovery ───────────────────────────

def test_reverse_passes_through_agui_shaped_parts():
    """Already-AG-UI-shaped parts (not LiteLLM image_url) must survive the
    reverse converter unchanged, not get dropped. Regression: the converter used
    to drop everything except text/image_url, silently losing content that
    reached flow state from an older build, a checkpoint restore, or a user
    flow."""
    agui_image = {"type": "image", "source": {"type": "url", "value": "https://x/y.jpg"}}
    agui_audio = {"type": "audio", "source": {"type": "data", "value": "AA", "mime_type": "audio/mp3"}}
    content = [{"type": "text", "text": "hello"}, agui_image, agui_audio]
    result = convert_litellm_multimodal_to_agui(content)
    assert result == [{"type": "text", "text": "hello"}, agui_image, agui_audio]


def test_reverse_path_preserves_agui_image_through_translation():
    """Through the real litellm_messages_to_ag_ui_messages: an AG-UI-shaped image
    part in stored state round-trips to a valid UserMessage, not dropped."""
    stored = {
        "id": "u1",
        "role": "user",
        "content": [
            {"type": "text", "text": "hello"},
            {"type": "image", "source": {"type": "url", "value": "https://x/y.jpg"}},
        ],
    }
    out = litellm_messages_to_ag_ui_messages([stored])
    assert len(out) == 1
    assert len(out[0].content) == 2
    assert isinstance(out[0].content[1], _ImageInputContent)


def test_reverse_data_url_relabels_non_image_media():
    """A data: image_url whose mime is non-image re-labels to the right AG-UI
    part type rather than always ``image``."""
    from ag_ui.core import AudioInputContent as _Audio, DocumentInputContent as _Doc

    audio = litellm_messages_to_ag_ui_messages([{
        "id": "a", "role": "user",
        "content": [{"type": "image_url", "image_url": {"url": "data:audio/mp3;base64,AA"}}],
    }])
    assert isinstance(audio[0].content[0], _Audio)

    doc = litellm_messages_to_ag_ui_messages([{
        "id": "d", "role": "user",
        "content": [{"type": "image_url", "image_url": {"url": "data:application/pdf;base64,AA"}}],
    }])
    assert isinstance(doc[0].content[0], _Doc)


def test_crewai_files_probe_matches_find_spec():
    """The cached probe reflects the real crewai_files distribution presence,
    so a typo'd module name would be caught in CI."""
    import importlib.util
    assert _capabilities._crewai_files_available == (
        importlib.util.find_spec("crewai_files") is not None
    )
