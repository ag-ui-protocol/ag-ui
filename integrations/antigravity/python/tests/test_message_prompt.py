"""Mapping AG-UI message content onto the prompt the harness accepts."""

import base64

from ag_ui.core import (
    DataSource,
    DocumentPart,
    ImagePart,
    TextPart,
    UrlSource,
)
from google.antigravity import types as ag_types

from ag_ui_antigravity.agent import _message_prompt

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
PDF = b"%PDF-1.4\n%fake"


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def image(value, *, source="data", mime="image/png", filename=None):
    src = (
        DataSource(type="data", value=value, mime_type=mime)
        if source == "data"
        else UrlSource(type="url", value=value, mime_type=mime)
    )
    return ImagePart(
        type="image", source=src, metadata={"filename": filename} if filename else None
    )


class TestTextOnly:
    def test_a_string_stays_a_string(self):
        assert _message_prompt("  hello  ") == "hello"

    def test_text_parts_are_joined_into_one_string(self):
        content = [TextPart(type="text", text="one"), TextPart(type="text", text="two")]
        assert _message_prompt(content) == "one\ntwo"

    def test_empty_content_is_empty(self):
        assert _message_prompt([TextPart(type="text", text="  ")]) == ""
        assert _message_prompt(None) == ""


class TestMedia:
    def test_an_inline_image_becomes_sdk_media_after_the_text(self):
        prompt = _message_prompt(
            [TextPart(type="text", text="what is this?"), image(b64(PNG), filename="a.png")]
        )
        assert prompt[0] == "what is this?"
        assert isinstance(prompt[1], ag_types.Image)
        assert prompt[1].data == PNG
        assert prompt[1].mime_type == "image/png"
        assert prompt[1].description == "a.png"

    def test_an_inline_pdf_becomes_a_document(self):
        doc = DocumentPart(
            type="document",
            source=DataSource(type="data", value=b64(PDF), mime_type="application/pdf"),
        )
        prompt = _message_prompt([TextPart(type="text", text="summarize"), doc])
        assert isinstance(prompt[1], ag_types.Document)
        assert prompt[1].data == PDF

    def test_a_data_url_is_decoded(self):
        url = "data:image/png;base64," + b64(PNG)
        prompt = _message_prompt([image(url, source="url", mime=None)])
        assert isinstance(prompt[0], ag_types.Image)
        assert prompt[0].data == PNG

    def test_an_attachment_alone_is_still_a_turn(self):
        prompt = _message_prompt([image(b64(PNG))])
        assert len(prompt) == 1 and isinstance(prompt[0], ag_types.Image)


class TestUnforwardable:
    def test_a_remote_url_becomes_a_note_not_a_silent_drop(self):
        prompt = _message_prompt(
            [
                TextPart(type="text", text="look"),
                image("https://example.com/x.png", source="url", filename="x.png"),
            ]
        )
        assert isinstance(prompt, str)
        assert prompt.startswith("look\n[Attached image 'x.png' was not forwarded")
        assert "only inline attachments" in prompt

    def test_an_unsupported_mime_type_becomes_a_note(self):
        prompt = _message_prompt([image(b64(b"GIF89a"), mime="image/gif")])
        assert isinstance(prompt, str)
        assert "could not be read" in prompt
