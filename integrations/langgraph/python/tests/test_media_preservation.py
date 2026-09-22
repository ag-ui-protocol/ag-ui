"""Provider-neutral attachment conversion without model calls or URL fetches."""
import unittest

from ag_ui_langgraph.utils import (
    BinaryInputContent,
    convert_agui_multimodal_to_langchain,
    convert_langchain_multimodal_to_agui,
)
from tests._helpers import AudioPart, VideoPart, DocumentPart, DataSource, UrlSource


class TestMediaPreservation(unittest.TestCase):
    def test_remote_document_keeps_a_supplied_name_matching_an_inline_default(self):
        original = DocumentPart(
            source=UrlSource(
                type="url", value="https://example.com/object", mime_type="application/pdf"
            ),
            metadata={"filename": "attachment.pdf"},
        )
        [returned] = convert_langchain_multimodal_to_agui(
            convert_agui_multimodal_to_langchain([original])
        )
        self.assertEqual(returned.metadata, {"filename": "attachment.pdf"})

    def test_non_image_media_preserve_kind_payload_mime_and_filename(self):
        for cls, kind, block_type, mime in (
            (AudioPart, "audio", "audio", "audio/ogg"),
            (VideoPart, "video", "video", "video/mp4"),
            (DocumentPart, "document", "file", "text/plain"),
        ):
            for source_kind in (
                "data", "data_url", "url",
                "legacy_data", "legacy_data_url", "legacy_url",
            ):
                with self.subTest(kind=kind, source=source_kind):
                    remote = source_kind in ("url", "legacy_url")
                    value = "https://example.com/signed?token=abc" if remote else "AAECA/8="
                    wire_value = (
                        f"data:{mime};base64,{value}"
                        if source_kind.endswith("data_url") else value
                    )
                    if source_kind.startswith("legacy"):
                        field = "data" if source_kind == "legacy_data" else "url"
                        original = BinaryInputContent(
                            mime_type=mime, filename="original.bin", **{field: wire_value}
                        )
                    else:
                        source = (
                            DataSource(type="data", value=value, mime_type=mime)
                            if source_kind == "data"
                            else UrlSource(type="url", value=wire_value, mime_type=mime)
                        )
                        original = cls(
                            type=kind, source=source, metadata={"filename": "original.bin"}
                        )
                    [block] = convert_agui_multimodal_to_langchain([original])
                    expected = {
                        "type": block_type, "mime_type": mime, "filename": "original.bin",
                    }
                    expected.update(
                        {"source_type": "url", "url": value} if remote else {"base64": value}
                    )
                    self.assertEqual(block, expected)
                    [returned] = convert_langchain_multimodal_to_agui([block])
                    self.assertIsInstance(returned, cls)
                    self.assertEqual(returned.source.value, value)
                    self.assertEqual(returned.source.mime_type, mime)
                    self.assertEqual(returned.metadata["filename"], "original.bin")

    def test_remote_media_without_mime_do_not_invent_one(self):
        for cls, kind, block_type in (
            (AudioPart, "audio", "audio"),
            (VideoPart, "video", "video"),
            (DocumentPart, "document", "file"),
        ):
            with self.subTest(kind=kind):
                [block] = convert_agui_multimodal_to_langchain([
                    cls(type=kind, source=UrlSource(type="url", value="https://example.com/object"))
                ])
                self.assertEqual(block, {
                    "type": block_type, "source_type": "url", "url": "https://example.com/object",
                })
