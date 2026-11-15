"""The two 0.x names 1.0 keeps importable for one release (see DEPRECATIONS.md).

Both are cushions for code written against 0.x, not protocol surface:
``BinaryInputContent`` is a standalone class no message shape carries, and
``SubAgentInfo`` is the old spelling of ``SubagentInfo``.
"""

import unittest

from pydantic import ValidationError

import ag_ui.core
from ag_ui.core import BinaryInputContent, SubAgentInfo, SubagentInfo, UserMessage


class TestBinaryInputContent(unittest.TestCase):
    def test_is_exported(self):
        self.assertIn("BinaryInputContent", ag_ui.core.__all__)

    def test_validates_the_legacy_wire_shape(self):
        part = BinaryInputContent.model_validate(
            {"type": "binary", "mimeType": "image/png", "data": "aGk=", "filename": "a.png"}
        )
        self.assertEqual(part.mime_type, "image/png")
        self.assertEqual(part.data, "aGk=")
        self.assertEqual(part.filename, "a.png")
        dumped = part.model_dump(by_alias=True, exclude_none=True)
        self.assertEqual(dumped, {"type": "binary", "mimeType": "image/png", "data": "aGk=", "filename": "a.png"})

    def test_requires_a_payload_source_as_0x_did(self):
        with self.assertRaises(ValidationError):
            BinaryInputContent.model_validate({"type": "binary", "mimeType": "image/png"})

    def test_is_not_a_content_part(self):
        # The protocol retired the part: a message carrying one is rejected at
        # validation. The class exists so an import survives, not the shape.
        with self.assertRaises(ValidationError):
            UserMessage.model_validate(
                {"id": "u", "role": "user", "content": [{"type": "binary", "mimeType": "image/png", "data": "aGk="}]}
            )


class TestSubAgentInfo(unittest.TestCase):
    def test_is_an_alias_of_the_1_0_class(self):
        self.assertIs(SubAgentInfo, SubagentInfo)
        self.assertIn("SubAgentInfo", ag_ui.core.__all__)

    def test_wire_key_is_the_1_0_spelling_only(self):
        from ag_ui.core import MultiAgentCapabilities

        caps = MultiAgentCapabilities.model_validate({"subagents": [{"name": "researcher"}]})
        self.assertEqual(caps.subagents[0].name, "researcher")
        # The alias renames the class, not the key: the old key is unknown material.
        old_key = MultiAgentCapabilities.model_validate({"subAgents": [{"name": "researcher"}]})
        self.assertIsNone(old_key.subagents)


if __name__ == "__main__":
    unittest.main()
