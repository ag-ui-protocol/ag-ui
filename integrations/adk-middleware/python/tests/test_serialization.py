"""Tests for the shared serialize_tool_args helper.

Covers plain dicts, dicts containing Python Enums (the SecuritySchemeType
scenario), dicts containing Pydantic models, non-dict values, and edge cases.
"""

import enum
import json

from pydantic import BaseModel

from ag_ui_adk.serialization import serialize_tool_args


class FakeSecuritySchemeType(enum.Enum):
    oauth2 = "oauth2"
    apiKey = "apiKey"


class NestedModel(BaseModel):
    url: str
    scheme_type: FakeSecuritySchemeType


class TestSerializeToolArgs:

    def test_plain_dict(self):
        args = {"city": "Seattle", "units": "metric"}
        result = serialize_tool_args(args)
        assert json.loads(result) == args

    def test_dict_with_enum_value(self):
        """Regression (#1331): SecuritySchemeType-like enums must not raise TypeError."""
        args = {
            "auth_type": FakeSecuritySchemeType.oauth2,
            "scopes": ["read", "write"],
        }
        result = serialize_tool_args(args)
        parsed = json.loads(result)
        assert parsed["auth_type"] == "oauth2"
        assert parsed["scopes"] == ["read", "write"]

    def test_dict_with_pydantic_model_value(self):
        args = {
            "endpoint": NestedModel(
                url="https://example.com",
                scheme_type=FakeSecuritySchemeType.apiKey,
            )
        }
        result = serialize_tool_args(args)
        parsed = json.loads(result)
        assert parsed["endpoint"]["url"] == "https://example.com"
        assert parsed["endpoint"]["scheme_type"] == "apiKey"

    def test_dict_with_nested_enum(self):
        args = {
            "config": {
                "type": FakeSecuritySchemeType.oauth2,
                "enabled": True,
            }
        }
        result = serialize_tool_args(args)
        parsed = json.loads(result)
        assert parsed["config"]["type"] == "oauth2"

    def test_string_args_passthrough(self):
        assert serialize_tool_args("raw_string") == "raw_string"

    def test_non_dict_non_string(self):
        assert serialize_tool_args(42) == "42"

    def test_empty_dict(self):
        assert serialize_tool_args({}) == "{}"
