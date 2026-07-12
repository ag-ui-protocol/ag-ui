"""
Tests for AGUIToSDKTranslator's multimodal content mapping.

Pins the wire shape each ``translate_*_content`` method produces (or the
``None``/drop behavior when unsupported), per the table in
``.dev/MESSAGES.md`` / ``.dev/INTEGRATIONS_MATRIX.md``. No network, no model;
just the mapping.
"""

from __future__ import annotations

import warnings

from ag_ui.core import (
    AudioInputContent,
    BinaryInputContent,
    DocumentInputContent,
    ImageInputContent,
    InputContentDataSource,
    InputContentUrlSource,
    TextInputContent,
    VideoInputContent,
)

from ag_ui_openai_agents.engine.agui_to_sdk import AGUIToSDKTranslator

_engine = AGUIToSDKTranslator()


def _binary(**kwargs) -> BinaryInputContent:
    """BinaryInputContent is deprecated but still a real inbound shape callers
    may send; construct it without polluting test output with the warning."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        return BinaryInputContent(**kwargs)


# ── image ──────────────────────────────────────────────────────────────


def test_image_url_source_passes_through():
    part = ImageInputContent(source=InputContentUrlSource(value="https://x/y.png"))
    out = _engine.translate_image_content(part)
    assert out == {"type": "input_image", "image_url": "https://x/y.png"}


def test_image_data_source_becomes_data_url():
    part = ImageInputContent(
        source=InputContentDataSource(value="Zm9v", mime_type="image/png")
    )
    out = _engine.translate_image_content(part)
    assert out == {"type": "input_image", "image_url": "data:image/png;base64,Zm9v"}


def test_image_with_no_usable_source_returns_none():
    part = ImageInputContent(source=InputContentDataSource(value="", mime_type="image/png"))
    assert _engine.translate_image_content(part) is None


# ── audio ──────────────────────────────────────────────────────────────


def test_audio_data_source_maps_to_input_audio():
    part = AudioInputContent(
        source=InputContentDataSource(value="Zm9v", mime_type="audio/wav")
    )
    out = _engine.translate_audio_content(part)
    assert out == {
        "type": "input_audio",
        "input_audio": {"data": "Zm9v", "format": "wav"},
    }


def test_audio_url_source_is_dropped():
    # Responses API accepts no URL form for audio input.
    part = AudioInputContent(source=InputContentUrlSource(value="https://x/y.wav"))
    assert _engine.translate_audio_content(part) is None


def test_audio_missing_mime_defaults_to_wav():
    part = AudioInputContent(source=InputContentDataSource(value="Zm9v", mime_type=""))
    out = _engine.translate_audio_content(part)
    assert out["input_audio"]["format"] == "wav"


def test_audio_format_from_mime_variants():
    fmt = _engine._audio_format_from_mime
    assert fmt("audio/mpeg") == "mp3"
    assert fmt("audio/mp3") == "mp3"
    assert fmt("audio/mpeg3") == "mp3"
    assert fmt("audio/x-wav") == "wav"
    assert fmt("audio/wav") == "wav"
    assert fmt("audio/wave") == "wav"
    assert fmt("audio/ogg") == "ogg"
    assert fmt(None) == "wav"


# ── document ───────────────────────────────────────────────────────────


def test_document_url_source_uses_file_url():
    part = DocumentInputContent(source=InputContentUrlSource(value="https://x/y.pdf"))
    out = _engine.translate_document_content(part)
    assert out == {"type": "input_file", "file_url": "https://x/y.pdf"}


def test_document_data_source_uses_file_data():
    part = DocumentInputContent(
        source=InputContentDataSource(value="Zm9v", mime_type="application/pdf")
    )
    out = _engine.translate_document_content(part)
    assert out == {
        "type": "input_file",
        "file_data": "data:application/pdf;base64,Zm9v",
    }


def test_document_with_no_usable_value_returns_none():
    part = DocumentInputContent(
        source=InputContentDataSource(value="", mime_type="application/pdf")
    )
    assert _engine.translate_document_content(part) is None


# ── video (unsupported by the Responses API) ─────────────────────────────


def test_video_is_always_dropped():
    part = VideoInputContent(source=InputContentUrlSource(value="https://x/y.mp4"))
    assert _engine.translate_video_content(part) is None


# ── binary (mime-sniffed, routed to image/audio/file) ────────────────────


def test_binary_image_mime_routes_to_image_url():
    part = _binary(mime_type="image/png", url="https://x/y.png")
    out = _engine.translate_binary_content(part)
    assert out == {"type": "input_image", "image_url": "https://x/y.png"}


def test_binary_audio_mime_routes_to_input_audio():
    part = _binary(mime_type="audio/wav", data="Zm9v")
    out = _engine.translate_binary_content(part)
    assert out == {
        "type": "input_audio",
        "input_audio": {"data": "Zm9v", "format": "wav"},
    }


def test_binary_other_mime_routes_to_file():
    part = _binary(mime_type="application/pdf", data="Zm9v", filename="a.pdf")
    out = _engine.translate_binary_content(part)
    assert out == {
        "type": "input_file",
        "file_data": "data:application/pdf;base64,Zm9v",
        "filename": "a.pdf",
    }


def test_binary_as_image_prefers_url_over_data():
    part = _binary(mime_type="image/png", url="https://x/y.png", data="Zm9v")
    out = _engine._binary_as_image(part)
    assert out == {"type": "input_image", "image_url": "https://x/y.png"}


def test_binary_as_image_falls_back_to_data():
    part = _binary(mime_type="image/png", data="Zm9v")
    out = _engine._binary_as_image(part)
    assert out == {"type": "input_image", "image_url": "data:image/png;base64,Zm9v"}


def test_binary_as_image_with_neither_returns_none():
    part = _binary(mime_type="image/png", id="file-123")
    assert _engine._binary_as_image(part) is None


def test_binary_as_audio_without_data_is_dropped():
    # URL-only audio isn't accepted by the Responses API.
    part = _binary(mime_type="audio/wav", url="https://x/y.wav")
    assert _engine._binary_as_audio(part, "audio/wav") is None


def test_binary_as_file_url_source():
    part = _binary(mime_type="application/pdf", url="https://x/y.pdf")
    out = _engine._binary_as_file(part, "application/pdf")
    assert out == {"type": "input_file", "file_url": "https://x/y.pdf"}


def test_binary_as_file_data_without_filename_omits_key():
    part = _binary(mime_type="application/pdf", data="Zm9v")
    out = _engine._binary_as_file(part, "application/pdf")
    assert out == {"type": "input_file", "file_data": "data:application/pdf;base64,Zm9v"}
    assert "filename" not in out


# ── source resolution helper ──────────────────────────────────────────────


def test_data_source_to_url_handles_url_data_and_none():
    fn = _engine._data_source_to_url
    assert fn(InputContentUrlSource(value="https://x/y.png")) == "https://x/y.png"
    assert (
        fn(InputContentDataSource(value="Zm9v", mime_type="image/png"))
        == "data:image/png;base64,Zm9v"
    )
    assert fn(None) is None


# ── dict-shaped fallback dispatch ─────────────────────────────────────────


def test_dispatch_dict_content_part_text():
    out = _engine._dispatch_dict_content_part({"type": "text", "text": "hi"})
    assert out == {"type": "input_text", "text": "hi"}


def test_dispatch_dict_content_part_image():
    out = _engine._dispatch_dict_content_part(
        {"type": "image", "source": {"type": "url", "value": "https://x/y.png"}}
    )
    assert out == {"type": "input_image", "image_url": "https://x/y.png"}


def test_dispatch_dict_content_part_unknown_type_returns_none():
    assert _engine._dispatch_dict_content_part({"type": "carrier_pigeon"}) is None


# ── translate_content_part tier-2 dispatcher ──────────────────────────────


def test_translate_content_part_dispatches_by_type():
    text = TextInputContent(text="hi")
    image = ImageInputContent(source=InputContentUrlSource(value="https://x/y.png"))
    assert _engine.translate_content_part(text) == {"type": "input_text", "text": "hi"}
    assert _engine.translate_content_part(image) == {
        "type": "input_image",
        "image_url": "https://x/y.png",
    }


# ── end-to-end: mixed multimodal user message ─────────────────────────────


def test_mixed_multimodal_parts_translate_to_matching_blocks():
    parts = [
        TextInputContent(text="what's this?"),
        ImageInputContent(source=InputContentUrlSource(value="https://x/y.png")),
        AudioInputContent(
            source=InputContentDataSource(value="Zm9v", mime_type="audio/mpeg")
        ),
        DocumentInputContent(source=InputContentUrlSource(value="https://x/y.pdf")),
        VideoInputContent(source=InputContentUrlSource(value="https://x/y.mp4")),
    ]
    blocks = [_engine.translate_content_part(p) for p in parts]
    assert blocks == [
        {"type": "input_text", "text": "what's this?"},
        {"type": "input_image", "image_url": "https://x/y.png"},
        {"type": "input_audio", "input_audio": {"data": "Zm9v", "format": "mp3"}},
        {"type": "input_file", "file_url": "https://x/y.pdf"},
        None,  # video: no Responses-API input block
    ]
