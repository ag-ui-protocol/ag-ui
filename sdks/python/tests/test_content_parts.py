"""Tool results carry the same content parts as user messages (PNI-427)."""

import unittest

from pydantic import TypeAdapter, ValidationError

from ag_ui.core import (
    ContentPart,
    DataSource,
    DocumentPart,
    Message,
    TextPart,
    ToolCallResultEvent,
    ToolMessage,
    UrlSource,
)
from ag_ui.core import types as core_types


PARTS = [
    TextPart(
        id="p1",
        text="Proration rules: when a plan changes mid-cycle...",
        metadata={"source": "https://docs.internal/billing/proration", "title": "Proration rules"},
    ),
    DocumentPart(source=DataSource(value="JVBERi0x", mime_type="application/pdf")),
]


class TestToolResultContent(unittest.TestCase):
    def test_tool_message_accepts_a_string(self):
        message = ToolMessage(id="m1", tool_call_id="c1", content="3 results found.")
        self.assertEqual(message.content, "3 results found.")

    def test_tool_message_accepts_parts(self):
        message = ToolMessage(id="m1", tool_call_id="c1", content=PARTS)
        dumped = message.model_dump(by_alias=True, exclude_none=True)
        self.assertEqual(dumped["content"][0]["type"], "text")
        self.assertEqual(dumped["content"][0]["metadata"]["title"], "Proration rules")
        self.assertEqual(dumped["content"][1]["source"]["mimeType"], "application/pdf")

    def test_tool_message_parts_round_trip_from_camel_case_json(self):
        message = ToolMessage.model_validate(
            {
                "id": "m1",
                "role": "tool",
                "toolCallId": "c1",
                "content": [
                    {"type": "text", "text": "Invoice attached."},
                    {
                        "type": "document",
                        "id": "inv",
                        "source": {"type": "url", "value": "https://example.com/i.pdf"},
                    },
                ],
            }
        )
        self.assertIsInstance(message.content, list)
        self.assertIsInstance(message.content[0], TextPart)
        self.assertIsInstance(message.content[1], DocumentPart)
        self.assertIsInstance(message.content[1].source, UrlSource)
        self.assertEqual(message.content[1].id, "inv")

    def test_tool_call_result_event_accepts_parts(self):
        event = ToolCallResultEvent(message_id="m2", tool_call_id="c1", content=PARTS)
        dumped = event.model_dump(by_alias=True, exclude_none=True)
        self.assertEqual(dumped["type"], "TOOL_CALL_RESULT")
        self.assertEqual(len(dumped["content"]), 2)

    def test_message_union_reads_a_tool_message_with_parts(self):
        message = TypeAdapter(Message).validate_python(
            {"id": "m1", "role": "tool", "toolCallId": "c1", "content": [{"type": "text", "text": "hi"}]}
        )
        self.assertIsInstance(message, ToolMessage)
        self.assertEqual(message.content[0].text, "hi")

    def test_unknown_part_type_is_rejected(self):
        with self.assertRaises(ValidationError):
            ToolMessage.model_validate(
                {
                    "id": "m1",
                    "role": "tool",
                    "toolCallId": "c1",
                    "content": [{"type": "search_result", "source": "https://example.com", "title": "x"}],
                }
            )

    def test_structured_data_is_serialised_not_passed_as_an_object(self):
        with self.assertRaises(ValidationError):
            ToolMessage.model_validate(
                {"id": "m1", "role": "tool", "toolCallId": "c1", "content": {"temperature": 22.5}}
            )


class TestTextPart(unittest.TestCase):
    def test_carries_optional_id_and_metadata(self):
        part = TypeAdapter(ContentPart).validate_python(
            {"type": "text", "id": "p1", "text": "hi", "metadata": {"title": "t"}}
        )
        self.assertIsInstance(part, TextPart)
        self.assertEqual(part.id, "p1")
        self.assertEqual(part.metadata, {"title": "t"})
        bare = TextPart(text="hi")
        self.assertEqual(bare.model_dump(by_alias=True, exclude_none=True), {"type": "text", "text": "hi"})


class TestPre10Names(unittest.TestCase):
    """The names the parts carried before the rename are the same classes."""

    def test_aliases_are_identical_classes(self):
        self.assertIs(core_types.InputContent, core_types.ContentPart)
        self.assertIs(core_types.TextInputContent, core_types.TextPart)
        self.assertIs(core_types.ImageInputContent, core_types.ImagePart)
        self.assertIs(core_types.AudioInputContent, core_types.AudioPart)
        self.assertIs(core_types.VideoInputContent, core_types.VideoPart)
        self.assertIs(core_types.DocumentInputContent, core_types.DocumentPart)
        self.assertIs(core_types.InputContentSource, core_types.PartSource)
        self.assertIs(core_types.InputContentDataSource, core_types.DataSource)
        self.assertIs(core_types.InputContentUrlSource, core_types.UrlSource)

    def test_old_names_still_construct_and_validate(self):
        part = core_types.TextInputContent(text="hi")
        self.assertIsInstance(part, TextPart)
        source = core_types.InputContentUrlSource(value="https://example.com/a.png", mime_type="image/png")
        image = core_types.ImageInputContent(source=source)
        self.assertEqual(image.model_dump(by_alias=True, exclude_none=True)["source"]["type"], "url")


if __name__ == "__main__":
    unittest.main()
