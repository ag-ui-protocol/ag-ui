"""
Tests for multimodal message conversion between AG-UI and LangChain formats.
"""

import unittest
from ag_ui.core import (
    UserMessage,
    TextInputContent,
    BinaryInputContent,
)
from langchain_core.messages import HumanMessage

from ag_ui_langgraph.utils import (
    agui_messages_to_langchain,
    langchain_messages_to_agui,
    convert_agui_multimodal_to_langchain,
    convert_langchain_multimodal_to_agui,
    flatten_user_content,
)


class TestMultimodalConversion(unittest.TestCase):
    """Test multimodal message conversion between AG-UI and LangChain."""

    def test_agui_text_only_to_langchain(self):
        """Test converting a text-only AG-UI message to LangChain."""
        agui_message = UserMessage(
            id="test-1",
            role="user",
            content="Hello, world!"
        )

        lc_messages = agui_messages_to_langchain([agui_message])

        self.assertEqual(len(lc_messages), 1)
        self.assertIsInstance(lc_messages[0], HumanMessage)
        self.assertEqual(lc_messages[0].content, "Hello, world!")
        self.assertEqual(lc_messages[0].id, "test-1")

    def test_agui_multimodal_to_langchain(self):
        """Test converting a multimodal AG-UI message to LangChain."""
        agui_message = UserMessage(
            id="test-2",
            role="user",
            content=[
                TextInputContent(type="text", text="What's in this image?"),
                BinaryInputContent(
                    type="binary",
                    mime_type="image/jpeg",
                    url="https://example.com/photo.jpg"
                ),
            ]
        )

        lc_messages = agui_messages_to_langchain([agui_message])

        self.assertEqual(len(lc_messages), 1)
        self.assertIsInstance(lc_messages[0], HumanMessage)
        self.assertIsInstance(lc_messages[0].content, list)
        self.assertEqual(len(lc_messages[0].content), 2)

        # Check text content
        self.assertEqual(lc_messages[0].content[0]["type"], "text")
        self.assertEqual(lc_messages[0].content[0]["text"], "What's in this image?")

        # Check image content
        self.assertEqual(lc_messages[0].content[1]["type"], "image_url")
        self.assertEqual(
            lc_messages[0].content[1]["image_url"]["url"],
            "https://example.com/photo.jpg"
        )

    def test_agui_multimodal_with_data_to_langchain(self):
        """Test converting AG-UI message with base64 data to LangChain."""
        agui_message = UserMessage(
            id="test-3",
            role="user",
            content=[
                TextInputContent(type="text", text="Analyze this"),
                BinaryInputContent(
                    type="binary",
                    mime_type="image/png",
                    data="iVBORw0KGgoAAAANSUhEUgAAAAUA",
                    filename="test.png"
                ),
            ]
        )

        lc_messages = agui_messages_to_langchain([agui_message])

        self.assertEqual(len(lc_messages), 1)
        self.assertIsInstance(lc_messages[0].content, list)
        self.assertEqual(len(lc_messages[0].content), 2)

        # Check that data URL is properly formatted
        image_content = lc_messages[0].content[1]
        self.assertEqual(image_content["type"], "image_url")
        self.assertTrue(
            image_content["image_url"]["url"].startswith("data:image/png;base64,")
        )

    def test_langchain_multimodal_to_agui(self):
        """Test converting LangChain multimodal message to AG-UI."""
        lc_message = HumanMessage(
            id="test-4",
            content=[
                {"type": "text", "text": "What do you see?"},
                {
                    "type": "image_url",
                    "image_url": {"url": "https://example.com/image.jpg"}
                },
            ]
        )

        agui_messages = langchain_messages_to_agui([lc_message])

        self.assertEqual(len(agui_messages), 1)
        self.assertEqual(agui_messages[0].role, "user")
        self.assertIsInstance(agui_messages[0].content, list)
        self.assertEqual(len(agui_messages[0].content), 2)

        # Check text content
        self.assertIsInstance(agui_messages[0].content[0], TextInputContent)
        self.assertEqual(agui_messages[0].content[0].text, "What do you see?")

        # Check binary content
        self.assertIsInstance(agui_messages[0].content[1], BinaryInputContent)
        self.assertEqual(agui_messages[0].content[1].mime_type, "image/png")
        self.assertEqual(agui_messages[0].content[1].url, "https://example.com/image.jpg")

    def test_langchain_data_url_to_agui(self):
        """Test converting LangChain data URL to AG-UI."""
        lc_message = HumanMessage(
            id="test-5",
            content=[
                {"type": "text", "text": "Check this out"},
                {
                    "type": "image_url",
                    "image_url": {"url": "data:image/png;base64,iVBORw0KGgo"}
                },
            ]
        )

        agui_messages = langchain_messages_to_agui([lc_message])

        self.assertEqual(len(agui_messages), 1)
        self.assertIsInstance(agui_messages[0].content, list)
        self.assertEqual(len(agui_messages[0].content), 2)

        # Check that data URL was parsed correctly
        binary_content = agui_messages[0].content[1]
        self.assertIsInstance(binary_content, BinaryInputContent)
        self.assertEqual(binary_content.mime_type, "image/png")
        self.assertEqual(binary_content.data, "iVBORw0KGgo")

    def test_flatten_multimodal_content(self):
        """Test flattening multimodal content to plain text."""
        content = [
            TextInputContent(type="text", text="Hello"),
            BinaryInputContent(
                type="binary",
                mime_type="image/jpeg",
                url="https://example.com/image.jpg"
            ),
            TextInputContent(type="text", text="World"),
        ]

        flattened = flatten_user_content(content)

        self.assertIn("Hello", flattened)
        self.assertIn("World", flattened)
        self.assertIn("[Binary content: https://example.com/image.jpg]", flattened)

    def test_flatten_with_filename(self):
        """Test flattening binary content with filename."""
        content = [
            TextInputContent(type="text", text="Check this file"),
            BinaryInputContent(
                type="binary",
                mime_type="application/pdf",
                url="https://example.com/doc.pdf",
                filename="report.pdf"
            ),
        ]

        flattened = flatten_user_content(content)

        self.assertIn("Check this file", flattened)
        self.assertIn("[Binary content: report.pdf]", flattened)

    def test_convert_agui_multimodal_to_langchain_helper(self):
        """Test the convert_agui_multimodal_to_langchain helper function."""
        agui_content = [
            TextInputContent(type="text", text="Test text"),
            BinaryInputContent(
                type="binary",
                mime_type="image/png",
                url="https://example.com/test.png"
            ),
        ]

        lc_content = convert_agui_multimodal_to_langchain(agui_content)

        self.assertEqual(len(lc_content), 2)
        self.assertEqual(lc_content[0]["type"], "text")
        self.assertEqual(lc_content[0]["text"], "Test text")
        self.assertEqual(lc_content[1]["type"], "image_url")
        self.assertEqual(lc_content[1]["image_url"]["url"], "https://example.com/test.png")

    def test_convert_langchain_multimodal_to_agui_helper(self):
        """Test the convert_langchain_multimodal_to_agui helper function."""
        lc_content = [
            {"type": "text", "text": "Test text"},
            {"type": "image_url", "image_url": {"url": "https://example.com/test.png"}},
        ]

        agui_content = convert_langchain_multimodal_to_agui(lc_content)

        self.assertEqual(len(agui_content), 2)
        self.assertIsInstance(agui_content[0], TextInputContent)
        self.assertEqual(agui_content[0].text, "Test text")
        self.assertIsInstance(agui_content[1], BinaryInputContent)
        self.assertEqual(agui_content[1].url, "https://example.com/test.png")


if __name__ == "__main__":
    unittest.main()
