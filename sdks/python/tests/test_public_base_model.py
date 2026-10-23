"""Application models can share SDK serialization through the public base."""

import json
import unittest
from typing import Any, Dict, List, Optional

from pydantic import BaseModel as PydanticBaseModel, TypeAdapter

from ag_ui.core import BaseModel, ToolCallStartEvent
from ag_ui.core.types import ConfiguredBaseModel


class ApplicationPayload(BaseModel):
    request_id: str
    result: Any
    details: Dict[str, Any]
    optional_note: Optional[str] = None


class Envelope(PydanticBaseModel):
    payload: ApplicationPayload


class TestPublicBaseModel(unittest.TestCase):
    def setUp(self):
        self.payload = ApplicationPayload(
            request_id="request-1",
            result=None,
            details={"value": None, "items": [None]},
            extra_value=None,
        )
        self.expected = {
            "requestId": "request-1",
            "result": None,
            "details": {"value": None, "items": [None]},
            "extra_value": None,
        }

    def test_public_base_is_shared_with_existing_sdk_models(self):
        event = ToolCallStartEvent(tool_call_id="call-1", tool_call_name="search")
        self.assertIsInstance(event, BaseModel)
        self.assertIs(BaseModel, ConfiguredBaseModel)

    def test_custom_model_accepts_field_names_and_aliases(self):
        from_aliases = ApplicationPayload.model_validate(self.expected)
        self.assertEqual(from_aliases, self.payload)
        self.assertEqual(from_aliases.request_id, "request-1")
        expected = dict(self.expected)
        expected["request_id"] = expected.pop("requestId")
        self.assertEqual(from_aliases.model_dump(), expected)

    def test_custom_model_omits_only_fields_without_a_value(self):
        self.assertEqual(self.payload.model_dump(by_alias=True), self.expected)
        self.assertEqual(json.loads(self.payload.model_dump_json(by_alias=True)), self.expected)
        with_note = self.payload.model_copy(update={"optional_note": "keep me"})
        self.assertEqual(with_note.model_dump(by_alias=True)["optionalNote"], "keep me")

    def test_omission_survives_nesting_and_type_adapters(self):
        envelope = Envelope(payload=self.payload)
        self.assertEqual(envelope.model_dump(by_alias=True), {"payload": self.expected})
        self.assertEqual(json.loads(envelope.model_dump_json(by_alias=True)), {"payload": self.expected})
        adapter = TypeAdapter(List[ApplicationPayload])
        self.assertEqual(adapter.dump_python([self.payload], by_alias=True), [self.expected])
        self.assertEqual(json.loads(adapter.dump_json([self.payload], by_alias=True)), [self.expected])


if __name__ == "__main__":
    unittest.main()
