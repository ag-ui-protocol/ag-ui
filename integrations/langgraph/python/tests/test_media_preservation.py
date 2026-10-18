"""Provider-neutral attachment conversion without model calls or URL fetches."""
import unittest

from ag_ui.core import UserMessage
from langchain_core.messages import HumanMessage

from ag_ui_langgraph.utils import (
    BinaryInputContent,
    agui_messages_to_langchain,
    convert_agui_multimodal_to_langchain,
    convert_langchain_multimodal_to_agui,
    langchain_messages_to_agui,
)
from tests._helpers import (
    AudioPart,
    DataSource,
    DocumentPart,
    ImagePart,
    TextPart,
    UrlSource,
    VideoPart,
)


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


PNG = "iVBORw0KGgo="
MP4 = "AAAAIGZ0eXA="


def _user(content):
    # `model_construct`: the 1.0 message schema no longer admits the legacy
    # binary part, which old producers still send straight to servers.
    return UserMessage.model_construct(id="named", role="user", content=content)


class TestImageUrlFilenames(unittest.TestCase):
    """Images stay on ``image_url``, a block with nowhere to carry a name that
    providers accept: langchain-openai forwards it verbatim on Chat Completions,
    so any extra key on it reaches the provider request (issue #2100). Their
    filenames ride on the MESSAGE instead, in
    ``additional_kwargs["ag-ui"]["attachments"]``, the same shape the TypeScript
    adapter writes for images and video."""

    def test_records_an_image_filename_on_the_message_not_the_block(self):
        for label, item, url, filename in (
            (
                "inline",
                ImagePart(
                    type="image",
                    source=DataSource(type="data", value=PNG, mime_type="image/png"),
                    metadata={"filename": "sample.png"},
                ),
                f"data:image/png;base64,{PNG}",
                "sample.png",
            ),
            (
                "remote",
                ImagePart(
                    type="image",
                    source=UrlSource(type="url", value="https://example.com/a.png"),
                    metadata={"filename": "a.png"},
                ),
                "https://example.com/a.png",
                "a.png",
            ),
            (
                "legacy binary",
                BinaryInputContent(mime_type="image/png", data=PNG, filename="old.png"),
                f"data:image/png;base64,{PNG}",
                "old.png",
            ),
        ):
            with self.subTest(label):
                [message] = agui_messages_to_langchain(
                    [_user([TextPart(type="text", text="look"), item])]
                )
                self.assertEqual(message.content, [
                    {"type": "text", "text": "look"},
                    {"type": "image_url", "image_url": {"url": url}},
                ])
                self.assertEqual(message.additional_kwargs, {
                    "ag-ui": {"attachments": [
                        {"index": 1, "type": "image_url", "filename": filename}
                    ]},
                })

    def test_invents_no_carrier_for_an_unnamed_image(self):
        for metadata in (None, {"filename": ""}, {"filename": 42}):
            with self.subTest(metadata=metadata):
                [message] = agui_messages_to_langchain([_user([
                    ImagePart(
                        type="image",
                        source=DataSource(type="data", value=PNG, mime_type="image/png"),
                        metadata=metadata,
                    )
                ])])
                self.assertEqual(message.additional_kwargs, {})
                [restored] = langchain_messages_to_agui([message])
                self.assertIsNone(restored.content[0].metadata)

    def test_keeps_every_name_on_its_own_part_across_a_mixed_message(self):
        [message] = agui_messages_to_langchain([_user([
            TextPart(type="text", text="four attachments"),
            ImagePart(
                type="image",
                source=DataSource(type="data", value=PNG, mime_type="image/png"),
                metadata={"filename": "sample.png"},
            ),
            DocumentPart(
                type="document",
                source=DataSource(type="data", value="JVBERi0=", mime_type="application/pdf"),
                metadata={"filename": "sample.pdf"},
            ),
            AudioPart(
                type="audio",
                source=DataSource(type="data", value="UklGRg==", mime_type="audio/wav"),
                metadata={"filename": "sample.wav"},
            ),
            VideoPart(
                type="video",
                source=DataSource(type="data", value=MP4, mime_type="video/mp4"),
                metadata={"filename": "cedar-video.mp4"},
            ),
        ])])
        # PDF, WAV and video keep their names on their own standard blocks.
        self.assertEqual(
            [b.get("filename") for b in message.content],
            [None, None, "sample.pdf", "sample.wav", "cedar-video.mp4"],
        )
        self.assertEqual(message.additional_kwargs, {
            "ag-ui": {"attachments": [
                {"index": 1, "type": "image_url", "filename": "sample.png"}
            ]},
        })
        [restored] = langchain_messages_to_agui([message])
        self.assertEqual(
            [getattr(p, "metadata", None) for p in restored.content],
            [
                None,
                {"filename": "sample.png"},
                {"filename": "sample.pdf"},
                {"filename": "sample.wav"},
                {"filename": "cedar-video.mp4"},
            ],
        )

    def test_counts_a_dropped_part_out_of_the_carrier_index(self):
        dropped = ImagePart.model_construct(
            type="image", source=DataSource.model_construct(type="data", value="")
        )
        [message] = agui_messages_to_langchain([_user([
            dropped,
            ImagePart(
                type="image",
                source=DataSource(type="data", value=PNG, mime_type="image/png"),
                metadata={"filename": "kept.png"},
            ),
        ])])
        self.assertEqual(len(message.content), 1)
        self.assertEqual(message.additional_kwargs, {
            "ag-ui": {"attachments": [
                {"index": 0, "type": "image_url", "filename": "kept.png"}
            ]},
        })

    def test_reads_what_the_typescript_adapter_stores_for_image_and_video(self):
        [restored] = langchain_messages_to_agui([HumanMessage(
            id="ts",
            content=[
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{PNG}"}},
                {
                    "type": "file", "source_type": "base64", "data": "JVBERi0=",
                    "mime_type": "application/pdf", "metadata": {"filename": "s.pdf"},
                },
                {"type": "image_url", "image_url": {"url": f"data:video/mp4;base64,{MP4}"}},
            ],
            additional_kwargs={"ag-ui": {"attachments": [
                {"index": 0, "type": "image_url", "filename": "s.png"},
                {"index": 2, "type": "image_url", "filename": "s.mp4"},
            ]}},
        )])
        self.assertEqual(
            [(p.type, p.source.mime_type, p.metadata) for p in restored.content],
            [
                ("image", "image/png", {"filename": "s.png"}),
                ("document", "application/pdf", {"filename": "s.pdf"}),
                ("video", "video/mp4", {"filename": "s.mp4"}),
            ],
        )

    def test_reads_a_carrier_nested_by_an_older_message_coercion(self):
        # langchain-core before 0.3.60 folds a message dict's
        # `additional_kwargs` key into additional_kwargs instead of merging it.
        [restored] = langchain_messages_to_agui([HumanMessage(
            id="old",
            content=[{"type": "image_url", "image_url": {"url": "https://example.com/n.png"}}],
            additional_kwargs={"type": "human", "additional_kwargs": {"ag-ui": {
                "attachments": [{"index": 0, "type": "image_url", "filename": "n.png"}]
            }}},
        )])
        self.assertEqual(restored.content[0].metadata, {"filename": "n.png"})

    def test_ignores_a_malformed_carrier_without_dropping_the_image(self):
        for label, additional_kwargs in (
            ("non-dict carrier", {"ag-ui": 7}),
            ("non-list attachments", {"ag-ui": {"attachments": {}}}),
            ("non-dict entry", {"ag-ui": {"attachments": [None, "x"]}}),
            ("string index", {"ag-ui": {"attachments": [
                {"index": "0", "type": "image_url", "filename": "x.png"}]}}),
            ("bool index", {"ag-ui": {"attachments": [
                {"index": False, "type": "image_url", "filename": "x.png"}]}}),
            ("fractional index", {"ag-ui": {"attachments": [
                {"index": 0.5, "type": "image_url", "filename": "x.png"}]}}),
            ("empty filename", {"ag-ui": {"attachments": [
                {"index": 0, "type": "image_url", "filename": ""}]}}),
            ("another block kind", {"ag-ui": {"attachments": [
                {"index": 0, "type": "file", "filename": "x.png"}]}}),
            ("index past the content", {"ag-ui": {"attachments": [
                {"index": 3, "type": "image_url", "filename": "x.png"}]}}),
        ):
            with self.subTest(label):
                [restored] = langchain_messages_to_agui([HumanMessage(
                    id="bad",
                    content=[{"type": "image_url", "image_url": {
                        "url": f"data:image/png;base64,{PNG}"}}],
                    additional_kwargs=additional_kwargs,
                )])
                self.assertEqual(len(restored.content), 1)
                self.assertEqual(restored.content[0].source.value, PNG)
                self.assertIsNone(restored.content[0].metadata)

    def test_a_carrier_entry_does_not_rename_a_standard_block(self):
        [restored] = langchain_messages_to_agui([HumanMessage(
            id="std",
            content=[{
                "type": "file", "base64": "JVBERi0=", "mime_type": "application/pdf",
                "filename": "real.pdf",
            }],
            additional_kwargs={"ag-ui": {"attachments": [
                {"index": 0, "type": "image_url", "filename": "wrong.png"}]}},
        )])
        self.assertEqual(restored.content[0].metadata, {"filename": "real.pdf"})
