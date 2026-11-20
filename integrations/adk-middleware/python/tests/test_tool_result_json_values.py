"""Frontend handlers may return any JSON value, not only objects."""

import json

import pytest
from ag_ui.core import ToolMessage
from ag_ui_adk import ADKAgent


@pytest.mark.parametrize(
    "value",
    [[{"id": "INC-1041"}], [], "approved", 42, False, None, {"records": []}],
)
def test_function_response_accepts_json_values(value):
    message = ToolMessage(
        id="result", role="tool", tool_call_id="client-call", content=json.dumps(value)
    )
    parts = ADKAgent._build_function_response_parts(
        None,
        [{"message": message, "tool_name": "get_records"}],
        {"client-call": "adk-call"},
    )
    response = parts[0].function_response
    assert response.response == (value if isinstance(value, dict) else {"result": value})
    assert response.name == "get_records"
    assert response.id == "adk-call"
